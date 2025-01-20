import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
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

// Initialize Solana connection with commitment and custom retry settings
const connection = new Connection("https://api.mainnet-beta.solana.com", {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
  disableRetryOnRateLimit: false,
  httpHeaders: {
    "Content-Type": "application/json",
  },
});

// Jupiter API base URL
const JUPITER_API_BASE = "https://quote-api.jup.ag/v6";

// Store active trackers in memory (but persist to Supabase)
const activeTrackers = new Map();

// Load the main wallet from environment variables
const mainWalletKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.MAIN_WALLET_PRIVATE_KEY)
);

// Rate limiting configuration
const RATE_LIMIT = {
  MIN_DELAY: 2000, // Minimum delay between requests (2 seconds)
  MAX_DELAY: 32000, // Maximum delay for retries (32 seconds)
  MAX_RETRIES: 8, // Maximum number of retries
  SCAN_INTERVAL: 30000, // Minimum interval between full scans (30 seconds)
  BATCH_SIZE: 3, // Number of concurrent requests
  BATCH_DELAY: 1000, // Delay between batches (1 second)
};

// Request queue implementation
class RequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, RATE_LIMIT.BATCH_SIZE);
      const promises = batch.map(async ({ fn, resolve, reject }) => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      await Promise.all(promises);
      if (this.queue.length > 0) {
        await delay(RATE_LIMIT.BATCH_DELAY);
      }
    }

    this.processing = false;
  }
}

const requestQueue = new RequestQueue();

// Helper function for delayed retries with exponential backoff
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exponentialBackoff = (attempt) => {
  const backoff = Math.min(
    RATE_LIMIT.MIN_DELAY * Math.pow(2, attempt),
    RATE_LIMIT.MAX_DELAY
  );
  return backoff + Math.random() * 1000; // Add jitter
};

// Known unsupported token mints
const UNSUPPORTED_TOKENS = new Set([
  "FKWy4E2Jcnaq2QBcMoFg1oDePGjrwW3WRVmtqCmxMQnu",
  // Add more known unsupported tokens here as they're discovered
]);

// Token validation helper
const isValidTokenInfo = (tokenInfo) => {
  if (!tokenInfo || typeof tokenInfo !== "object") return false;

  // Check for the correct token account structure
  if (!tokenInfo.tokenAmount || typeof tokenInfo.tokenAmount !== "object")
    return false;

  const { mint, tokenAmount } = tokenInfo;
  const { amount, decimals } = tokenAmount;

  return (
    typeof mint === "string" &&
    mint.length > 0 &&
    typeof amount === "string" &&
    !isNaN(parseInt(amount)) &&
    typeof decimals === "number" &&
    decimals >= 0 &&
    decimals <= 20 // Reasonable max for decimals
  );
};

class WalletTracker {
  constructor(id, walletAddress, solPercentage) {
    this.id = id;
    this.walletAddress = new PublicKey(walletAddress);
    this.solPercentage = solPercentage;
    this.isActive = true;
    this.lastTransaction = null;
    this.subscriptionId = null;
    this.tokenHoldings = new Map();
    this.retryCount = 0;
    this.lastScanTime = 0;
    this.scanInProgress = false;
    this.lastRequestTime = 0;
    console.log("Initialized tracker:", walletAddress);
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
      return; // Already tracking
    }

    // Subscribe to account changes
    this.subscriptionId = connection.onAccountChange(
      this.walletAddress,
      this.handleAccountChange.bind(this),
      "confirmed"
    );

    // Initial token scan
    await this.scanTokens();
  }

  async stopTracking() {
    if (this.subscriptionId) {
      await connection.removeAccountChangeListener(this.subscriptionId);
      this.subscriptionId = null;
    }
    this.isActive = false;
    await this.updateInDb();
  }

  async handleAccountChange(accountInfo, context) {
    try {
      // Update last transaction
      this.lastTransaction = context.slot.toString();
      await this.updateInDb();

      // Enforce minimum time between scans
      const now = Date.now();
      if (
        now - this.lastScanTime < RATE_LIMIT.SCAN_INTERVAL ||
        this.scanInProgress
      ) {
        return;
      }

      // Queue the token scan
      await requestQueue.add(async () => {
        await this.scanTokens();
        await this.checkOpportunities();
      });
    } catch (error) {
      console.error("Error handling account change:", error);
    }
  }

  async scanTokens(retryAttempt = 0) {
    if (this.scanInProgress) {
      console.log("Scan already in progress, skipping...");
      return;
    }

    this.scanInProgress = true;

    try {
      // Enforce rate limiting with exponential backoff
      if (retryAttempt > 0) {
        const backoff = exponentialBackoff(retryAttempt);
        console.log(
          `Retrying after ${backoff}ms delay (attempt ${retryAttempt}/${RATE_LIMIT.MAX_RETRIES})...`
        );
        await delay(backoff);
      } else {
        // Ensure minimum delay between requests even on first attempt
        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        if (timeSinceLastRequest < RATE_LIMIT.MIN_DELAY) {
          await delay(RATE_LIMIT.MIN_DELAY - timeSinceLastRequest);
        }
      }

      this.lastRequestTime = Date.now();

      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        this.walletAddress,
        { programId: TOKEN_PROGRAM_ID }
      );

      // Update last scan time
      this.lastScanTime = Date.now();

      // Update token holdings map
      this.tokenHoldings.clear();

      for (const { account, pubkey } of tokenAccounts.value) {
        try {
          const tokenInfo = account.data.parsed.info;

          // Skip if token info is invalid
          if (!isValidTokenInfo(tokenInfo)) {
            console.log("Invalid token info:", tokenInfo);
            continue;
          }

          const { mint } = tokenInfo;
          const { amount, decimals } = tokenInfo.tokenAmount;

          // Skip unsupported tokens
          if (UNSUPPORTED_TOKENS.has(mint)) {
            console.log(`Skipping unsupported token: ${mint}`);
            continue;
          }

          // Skip tokens with zero balance
          if (amount === "0") {
            continue;
          }

          // Calculate UI amount with proper decimal handling
          const uiAmount = parseFloat(amount) / Math.pow(10, decimals);

          // Skip if UI amount is invalid
          if (isNaN(uiAmount)) {
            console.log(`Invalid UI amount for token ${mint}`);
            continue;
          }

          this.tokenHoldings.set(mint, {
            amount,
            decimals,
            uiAmount,
            address: pubkey.toBase58(),
          });

          console.log("Token holding details:", {
            mint,
            amount,
            decimals,
            uiAmount,
          });
        } catch (error) {
          console.error("Error processing token account:", error);
          continue;
        }
      }

      // Reset retry count on successful scan
      this.retryCount = 0;
    } catch (error) {
      if (
        error.message.includes("429") &&
        retryAttempt < RATE_LIMIT.MAX_RETRIES
      ) {
        this.scanInProgress = false;
        return this.scanTokens(retryAttempt + 1);
      }
      console.error("Error scanning tokens:", error);
    } finally {
      this.scanInProgress = false;
    }
  }

  async checkOpportunities() {
    try {
      // Get main wallet SOL balance
      const mainBalance = await connection.getBalance(
        mainWalletKeypair.publicKey
      );
      const availableSOL = (mainBalance * this.solPercentage) / 100;

      // Process token holdings in batches
      const tokenEntries = Array.from(this.tokenHoldings.entries());
      for (let i = 0; i < tokenEntries.length; i += RATE_LIMIT.BATCH_SIZE) {
        const batch = tokenEntries.slice(i, i + RATE_LIMIT.BATCH_SIZE);
        const promises = batch.map(async ([mint, holding]) => {
          try {
            // Queue the quote request
            return await requestQueue.add(async () => {
              const response = await fetch(`${JUPITER_API_BASE}/quote`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  inputMint: mint,
                  outputMint: "So11111111111111111111111111111111111111112", // SOL
                  amount: holding.amount,
                  slippageBps: 50,
                  onlyDirectRoutes: false,
                }),
              });

              if (!response.ok) {
                throw new Error(`Jupiter API error: ${response.statusText}`);
              }

              const quote = await response.json();

              // If profit opportunity exists (e.g., > 1% after fees)
              if (quote.outAmount > availableSOL * 1.01) {
                await this.executeSwap(quote);
              }
            });
          } catch (error) {
            if (!error.message.includes("Bad Request")) {
              console.error(`Error getting quote for mint ${mint}:`, error);
            }
          }
        });

        await Promise.all(promises);
        if (i + RATE_LIMIT.BATCH_SIZE < tokenEntries.length) {
          await delay(RATE_LIMIT.BATCH_DELAY);
        }
      }
    } catch (error) {
      console.error("Error checking opportunities:", error);
    }
  }

  async executeSwap(quote) {
    try {
      // Queue the swap execution
      await requestQueue.add(async () => {
        const swapResponse = await fetch(`${JUPITER_API_BASE}/swap`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: mainWalletKeypair.publicKey.toString(),
            wrapUnwrapSOL: true,
          }),
        });

        if (!swapResponse.ok) {
          throw new Error(`Jupiter API error: ${swapResponse.statusText}`);
        }

        const { swapTransaction } = await swapResponse.json();

        // Add delay before transaction execution
        await delay(500);

        // Deserialize the transaction
        const transaction = Transaction.from(
          Buffer.from(swapTransaction, "base64")
        );

        // Sign the transaction
        transaction.partialSign(mainWalletKeypair);

        // Send and confirm the transaction
        const signature = await connection.sendRawTransaction(
          transaction.serialize()
        );
        await connection.confirmTransaction(signature);

        // Update last transaction
        this.lastTransaction = signature;
        await this.updateInDb();

        console.log(`Swap executed successfully: ${signature}`);
      });
    } catch (error) {
      console.error("Error executing swap:", error);
    }
  }
}

// Load existing trackers from database on startup
async function loadTrackers() {
  const { data: trackers, error } = await supabase
    .from("trackers")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("Error loading trackers:", error);
    return;
  }

  for (const tracker of trackers) {
    const walletTracker = new WalletTracker(
      tracker.id,
      tracker.wallet_address,
      tracker.sol_percentage
    );
    await walletTracker.startTracking();
    activeTrackers.set(tracker.wallet_address, walletTracker);
  }
}

// Load trackers on startup
loadTrackers();

// Health check endpoint for Render
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeTrackers: activeTrackers.size,
  });
});

// Keep-alive endpoint
app.get("/keep-alive", (req, res) => {
  res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.post("/api/trackers", async (req, res) => {
  try {
    const { walletAddress, solPercentage } = req.body;

    if (!walletAddress || !solPercentage) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Insert into database first
    const { data: tracker, error } = await supabase
      .from("trackers")
      .insert({
        wallet_address: walletAddress,
        sol_percentage: solPercentage,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Create and start tracker
    const walletTracker = new WalletTracker(
      tracker.id,
      walletAddress,
      solPercentage
    );
    await walletTracker.startTracking();
    activeTrackers.set(walletAddress, walletTracker);

    res.status(201).json(tracker);
  } catch (error) {
    console.error("Error creating tracker:", error);
    res.status(500).json({ error: "Failed to create tracker" });
  }
});

app.get("/api/trackers", async (req, res) => {
  try {
    const { data: trackers, error } = await supabase
      .from("trackers")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    res.json(trackers);
  } catch (error) {
    console.error("Error fetching trackers:", error);
    res.status(500).json({ error: "Failed to fetch trackers" });
  }
});

app.patch("/api/trackers/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const tracker = activeTrackers.get(address);
    const { isActive, solPercentage } = req.body;

    // Update database
    const { data: updatedTracker, error } = await supabase
      .from("trackers")
      .update({
        is_active: isActive,
        sol_percentage: solPercentage,
        updated_at: new Date().toISOString(),
      })
      .eq("wallet_address", address)
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Update memory tracker
    if (tracker) {
      if (isActive !== undefined) {
        if (isActive) {
          tracker.startTracking();
        } else {
          tracker.stopTracking();
        }
        tracker.isActive = isActive;
      }

      if (solPercentage !== undefined) {
        tracker.solPercentage = solPercentage;
      }
    }

    res.json(updatedTracker);
  } catch (error) {
    console.error("Error updating tracker:", error);
    res.status(500).json({ error: "Failed to update tracker" });
  }
});

app.delete("/api/trackers/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const tracker = activeTrackers.get(address);

    // Delete from database
    const { error } = await supabase
      .from("trackers")
      .delete()
      .eq("wallet_address", address);

    if (error) {
      throw error;
    }

    // Stop and remove from memory
    if (tracker) {
      tracker.stopTracking();
      activeTrackers.delete(address);
    }

    res.status(204).send();
  } catch (error) {
    console.error("Error deleting tracker:", error);
    res.status(500).json({ error: "Failed to delete tracker" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
