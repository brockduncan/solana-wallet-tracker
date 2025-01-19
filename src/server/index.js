import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import bs58 from "bs58";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Solana connection with commitment and rate limit config
const connection = new Connection("https://api.mainnet-beta.solana.com", {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
  wsEndpoint: "wss://api.mainnet-beta.solana.com/",
});

// Rate limiting configuration - Much more conservative now
const RATE_LIMIT_WINDOW = 60000; // 60 seconds (doubled)
const MAX_REQUESTS_PER_WINDOW = 3; // Reduced from 5
const requestCounts = new Map();

// Exponential backoff configuration - Longer delays
const INITIAL_BACKOFF = 5000; // 5 seconds (increased)
const MAX_BACKOFF = 300000; // 5 minutes (increased)
const MAX_RETRIES = 5; // Reduced from 8 to fail faster

// Minimum time between operations - Much longer intervals
const MIN_SCAN_INTERVAL = 300000; // 5 minutes between scans (increased)
const MIN_QUOTE_INTERVAL = 120000; // 2 minutes between quotes (increased)

// Operation-specific rate limits
const RATE_LIMITS = {
  scan: { window: 60000, max: 2 }, // 2 per minute
  balance: { window: 60000, max: 2 }, // 2 per minute
  quote: { window: 120000, max: 1 }, // 1 per 2 minutes
  swap: { window: 300000, max: 1 }, // 1 per 5 minutes
  transaction: { window: 300000, max: 1 }, // 1 per 5 minutes
};

// Jupiter API base URL
const JUPITER_API_BASE = "https://quote-api.jup.ag/v6";

// Store active trackers in memory (but persist to Supabase)
const activeTrackers = new Map();

// Load the main wallet from environment variables
const mainWalletKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.MAIN_WALLET_PRIVATE_KEY)
);

// Enhanced rate limiting function with operation-specific limits
function checkRateLimit(operation) {
  const now = Date.now();
  const limits = RATE_LIMITS[operation] || {
    window: RATE_LIMIT_WINDOW,
    max: MAX_REQUESTS_PER_WINDOW,
  };
  const windowStart = now - limits.window;

  // Clean up old entries
  for (const [k, data] of requestCounts.entries()) {
    if (data.timestamp < windowStart) {
      requestCounts.delete(k);
    }
  }

  const key = `${operation}-${now.toString().slice(0, -3)}`; // Group by second
  const data = requestCounts.get(key) || { count: 0, timestamp: now };

  if (data.cooldownUntil && now < data.cooldownUntil) {
    return false;
  }

  if (data.count >= limits.max) {
    data.cooldownUntil = now + limits.window;
    requestCounts.set(key, data);
    return false;
  }

  data.count += 1;
  data.timestamp = now;
  requestCounts.set(key, data);
  return true;
}

// Enhanced retry function with operation-specific handling
async function retryWithBackoff(operation, operationType, options = {}) {
  const {
    maxRetries = MAX_RETRIES,
    initialBackoff = INITIAL_BACKOFF,
    maxBackoff = MAX_BACKOFF,
  } = options;

  let retries = 0;
  let lastError;

  while (retries < maxRetries) {
    try {
      if (!checkRateLimit(operationType)) {
        const waitTime =
          RATE_LIMITS[operationType]?.window || RATE_LIMIT_WINDOW;
        console.log(
          `Rate limit reached for ${operationType}, waiting ${
            waitTime / 1000
          }s...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      return await operation();
    } catch (error) {
      lastError = error;

      const isRateLimit =
        error.message.includes("429") ||
        error.message.includes("Too many requests") ||
        error.message.includes("Rate limit exceeded");

      const isRetriable =
        isRateLimit ||
        error.message.includes("timeout") ||
        error.message.includes("network") ||
        error.message.includes("connection");

      if (isRetriable) {
        const backoffTime = Math.min(
          initialBackoff * Math.pow(2, retries),
          maxBackoff
        );
        console.log(
          `${operationType} failed (${error.message}). Retrying after ${
            backoffTime / 1000
          }s...`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
        retries++;
      } else {
        console.error(`Non-retriable error in ${operationType}:`, error);
        throw error;
      }
    }
  }

  console.error(
    `${operationType} failed after ${maxRetries} retries. Last error:`,
    lastError
  );
  throw lastError;
}

class WalletTracker {
  constructor(id, walletAddress, solPercentage) {
    this.id = id;
    this.walletAddress = new PublicKey(walletAddress);
    this.solPercentage = solPercentage;
    this.isActive = true;
    this.lastTransaction = null;
    this.subscriptionId = null;
    this.tokenHoldings = new Map();
    this.lastScanTime = 0;
    this.lastQuoteTime = 0;
    this.consecutiveErrors = 0;
    this.backoffUntil = 0;
  }

  async updateInDb() {
    await supabase
      .from("trackers")
      .update({
        is_active: this.isActive,
        last_transaction: this.lastTransaction,
        updated_at: new Date().toISOString(),
      })
      .eq("id", this.id);
  }

  async startTracking() {
    if (this.subscriptionId) {
      return;
    }

    try {
      this.subscriptionId = connection.onAccountChange(
        this.walletAddress,
        this.handleAccountChange.bind(this),
        "confirmed"
      );

      await this.scanTokens();
    } catch (error) {
      console.error("Error starting tracker:", error);
      this.isActive = false;
      await this.updateInDb();
    }
  }

  async stopTracking() {
    if (this.subscriptionId) {
      try {
        await connection.removeAccountChangeListener(this.subscriptionId);
      } catch (error) {
        console.error("Error removing account listener:", error);
      }
      this.subscriptionId = null;
    }
    this.isActive = false;
    await this.updateInDb();
  }

  shouldBackoff() {
    if (this.backoffUntil > Date.now()) {
      return true;
    }
    return false;
  }

  increaseBackoff() {
    this.consecutiveErrors++;
    const backoffTime = Math.min(
      INITIAL_BACKOFF * Math.pow(2, this.consecutiveErrors),
      MAX_BACKOFF
    );
    this.backoffUntil = Date.now() + backoffTime;
  }

  resetBackoff() {
    this.consecutiveErrors = 0;
    this.backoffUntil = 0;
  }

  async handleAccountChange(accountInfo, context) {
    try {
      if (this.shouldBackoff()) {
        return;
      }

      this.lastTransaction = context.slot.toString();
      await this.updateInDb();

      const now = Date.now();
      const canScan = now - this.lastScanTime >= MIN_SCAN_INTERVAL;
      const canQuote = now - this.lastQuoteTime >= MIN_QUOTE_INTERVAL;

      if (canScan) {
        this.lastScanTime = now;
        await this.scanTokens();

        if (canQuote) {
          this.lastQuoteTime = now;
          await this.checkOpportunities();
        }
      }

      this.resetBackoff();
    } catch (error) {
      console.error("Error handling account change:", error);
      this.increaseBackoff();
    }
  }

  async scanTokens() {
    try {
      const tokenAccounts = await retryWithBackoff(async () => {
        return await connection.getParsedTokenAccountsByOwner(
          this.walletAddress,
          { programId: TOKEN_PROGRAM_ID }
        );
      }, "scan");

      this.tokenHoldings.clear();
      for (const { account, pubkey } of tokenAccounts.value) {
        const { mint, amount } = account.data.parsed.info;
        if (amount > 0) {
          this.tokenHoldings.set(mint, {
            amount: amount,
            address: pubkey.toBase58(),
          });
        }
      }
    } catch (error) {
      console.error("Error scanning tokens:", error);
      this.increaseBackoff();
    }
  }

  async checkOpportunities() {
    try {
      const mainBalance = await retryWithBackoff(async () => {
        return await connection.getBalance(mainWalletKeypair.publicKey);
      }, "balance");

      const availableSOL = (mainBalance * this.solPercentage) / 100;

      for (const [mint, holding] of this.tokenHoldings) {
        try {
          const response = await retryWithBackoff(async () => {
            const res = await fetch(`${JUPITER_API_BASE}/quote`, {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                inputMint: mint,
                outputMint: "So11111111111111111111111111111111111111112",
                amount: holding.amount,
                slippageBps: 50,
                onlyDirectRoutes: false,
              }),
            });

            if (!res.ok) {
              throw new Error(`Jupiter API error: ${res.statusText}`);
            }

            return res;
          }, "quote");

          const quote = await response.json();

          if (quote.outAmount > availableSOL * 1.01) {
            await this.executeSwap(quote);
          }
        } catch (error) {
          if (!error.message.includes("Rate limit")) {
            console.error(`Error getting quote for mint ${mint}:`, error);
          }
          continue;
        }
      }
    } catch (error) {
      console.error("Error checking opportunities:", error);
      this.increaseBackoff();
    }
  }

  async executeSwap(quote) {
    try {
      const swapResponse = await retryWithBackoff(async () => {
        const res = await fetch(`${JUPITER_API_BASE}/swap`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: mainWalletKeypair.publicKey.toString(),
          }),
        });

        if (!res.ok) {
          throw new Error(`Jupiter API error: ${res.statusText}`);
        }

        return res;
      }, "swap");

      const { swapTransaction } = await swapResponse.json();
      const transaction = swapTransaction;
      transaction.sign([mainWalletKeypair]);

      const signature = await retryWithBackoff(async () => {
        const sig = await connection.sendTransaction(transaction);
        await connection.confirmTransaction(sig);
        return sig;
      }, "transaction");

      this.lastTransaction = signature;
      await this.updateInDb();
    } catch (error) {
      console.error("Error executing swap:", error);
      this.increaseBackoff();
    }
  }
}

// Rest of the code remains the same...
// (Express routes and server setup)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
