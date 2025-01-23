import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Solana connection
const connection = new Connection(
  "https://api.mainnet-beta.solana.com",
  "confirmed"
);

// Initialize main wallet
const mainWalletPrivateKey = bs58.decode(process.env.MAIN_WALLET_PRIVATE_KEY);
const mainWallet = Keypair.fromSecretKey(mainWalletPrivateKey);

// DEX Program IDs
const DEX_PROGRAMS = {
  ORCA: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  RAYDIUM: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
};

// Rate limiting settings
const RATE_LIMIT = {
  BATCH_SIZE: 25,
  BATCH_DELAY_MS: 1000,
  TOKENS_PER_SECOND: 4,
  BUCKET_SIZE: 10,
  MAX_RETRIES: 3,
  ACCOUNT_CHANGE_COOLDOWN_MS: 10000, // 10 seconds between account changes
};

// Token bucket rate limiter
class TokenBucket {
  constructor(tokensPerSecond, bucketSize) {
    this.tokensPerSecond = tokensPerSecond;
    this.bucketSize = bucketSize;
    this.tokens = bucketSize;
    this.lastRefill = Date.now();
    this.requestQueue = [];
    this.processing = false;
  }

  async refill() {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.bucketSize,
      this.tokens + timePassed * this.tokensPerSecond
    );
    this.lastRefill = now;
  }

  async acquireToken() {
    await this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async enqueueRequest(operation) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ operation, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) return;
    this.processing = true;

    while (this.requestQueue.length > 0) {
      if (await this.acquireToken()) {
        const { operation, resolve, reject } = this.requestQueue.shift();
        try {
          const result = await operation();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      } else {
        await delay(1000 / this.tokensPerSecond);
      }
    }

    this.processing = false;
  }
}

const rateLimiter = new TokenBucket(
  RATE_LIMIT.TOKENS_PER_SECOND,
  RATE_LIMIT.BUCKET_SIZE
);

// Utility function for delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Active trackers map
const activeTrackers = new Map();

class WalletTracker {
  constructor(id, walletAddress, solPercentage) {
    this.id = id;
    this.walletAddress = new PublicKey(walletAddress);
    this.solPercentage = solPercentage;
    this.isActive = true;
    this.lastTransaction = null;
    this.tokenHoldings = new Map();
    this.accountSubscription = null;
    this.isScanning = false;
    this.lastAccountChangeTime = 0;
  }

  async initialize() {
    try {
      console.log(
        `Initializing tracker for wallet: ${this.walletAddress.toString()}`
      );

      // Subscribe to account changes
      this.accountSubscription = connection.onAccountChange(
        this.walletAddress,
        this.handleAccountChange.bind(this),
        "confirmed"
      );

      // Initial token scan
      await this.scanTokens();

      console.log(
        `Tracker initialized for wallet: ${this.walletAddress.toString()}`
      );
    } catch (error) {
      console.error(
        `Error initializing tracker for ${this.walletAddress.toString()}:`,
        error
      );
      throw error;
    }
  }

  async scanTokens() {
    if (this.isScanning) {
      console.log(
        `Scan already in progress for wallet: ${this.walletAddress.toString()}`
      );
      return;
    }

    this.isScanning = true;

    try {
      console.log(
        `Scanning tokens for wallet: ${this.walletAddress.toString()}`
      );

      const tokenAccounts = await rateLimiter.enqueueRequest(() =>
        connection.getParsedTokenAccountsByOwner(this.walletAddress, {
          programId: TOKEN_PROGRAM_ID,
        })
      );

      this.tokenHoldings.clear();

      // Process tokens in batches
      const accounts = tokenAccounts.value;
      for (let i = 0; i < accounts.length; i += RATE_LIMIT.BATCH_SIZE) {
        const batch = accounts.slice(i, i + RATE_LIMIT.BATCH_SIZE);

        console.log(
          `Processing batch ${
            Math.floor(i / RATE_LIMIT.BATCH_SIZE) + 1
          } of ${Math.ceil(accounts.length / RATE_LIMIT.BATCH_SIZE)}`
        );

        for (const { account, pubkey } of batch) {
          const parsedInfo = account.data.parsed.info;
          if (parsedInfo.tokenAmount.uiAmount > 0) {
            this.tokenHoldings.set(parsedInfo.mint, {
              amount: parsedInfo.tokenAmount.amount,
              uiAmount: parsedInfo.tokenAmount.uiAmount,
              address: pubkey.toString(),
            });

            console.log(
              `Found token: ${parsedInfo.mint} with amount: ${parsedInfo.tokenAmount.uiAmount}`
            );
          }
        }

        // Add delay between batches
        await delay(RATE_LIMIT.BATCH_DELAY_MS);
      }

      console.log(
        `Found ${
          this.tokenHoldings.size
        } tokens for wallet: ${this.walletAddress.toString()}`
      );

      // Update database with latest scan
      await this.updateDatabase();
    } catch (error) {
      console.error(
        `Error scanning tokens for ${this.walletAddress.toString()}:`,
        error
      );
    } finally {
      this.isScanning = false;
    }
  }

  async handleAccountChange(accountInfo, context) {
    try {
      const now = Date.now();
      const timeSinceLastChange = now - this.lastAccountChangeTime;

      if (timeSinceLastChange < RATE_LIMIT.ACCOUNT_CHANGE_COOLDOWN_MS) {
        console.log(
          `Skipping account change processing - cooldown period (${Math.round(
            (RATE_LIMIT.ACCOUNT_CHANGE_COOLDOWN_MS - timeSinceLastChange) / 1000
          )}s remaining)`
        );
        return;
      }

      this.lastAccountChangeTime = now;
      console.log(
        `Account change detected for wallet: ${this.walletAddress.toString()}`
      );

      if (context.slot) {
        const signatures = await rateLimiter.enqueueRequest(() =>
          connection.getSignaturesForAddress(this.walletAddress, { limit: 1 })
        );

        if (signatures.length > 0) {
          this.lastTransaction = signatures[0].signature;
          await this.updateDatabase();

          // Get transaction details
          const txInfo = await rateLimiter.enqueueRequest(() =>
            connection.getTransaction(this.lastTransaction, {
              maxSupportedTransactionVersion: 0,
            })
          );

          if (txInfo) {
            await this.handleDexSwap(txInfo);
          }
        }
      }

      await this.scanTokens();
    } catch (error) {
      console.error(
        `Error handling account change for ${this.walletAddress.toString()}:`,
        error
      );
    }
  }

  async handleDexSwap(txInfo) {
    try {
      const programIds = txInfo.transaction.message.accountKeys.map((key) =>
        key.toString()
      );

      const isDexSwap = Object.values(DEX_PROGRAMS).some((programId) =>
        programIds.includes(programId)
      );

      if (!isDexSwap) {
        return;
      }

      console.log(`DEX swap detected in transaction: ${this.lastTransaction}`);

      // Analyze token balances before and after swap
      const preTokenBalances = txInfo.meta.preTokenBalances || [];
      const postTokenBalances = txInfo.meta.postTokenBalances || [];

      // Find the token that was swapped
      const changedBalances = this.analyzeBalanceChanges(
        preTokenBalances,
        postTokenBalances
      );

      if (changedBalances.length !== 2) {
        console.log("Could not determine swap tokens");
        return;
      }

      const [tokenIn, tokenOut] = changedBalances;
      const isSellingToken =
        tokenIn.mint !== SystemProgram.programId.toString();

      if (isSellingToken) {
        // User is selling a token for SOL
        await this.mirrorTokenSale(tokenIn.mint, tokenIn.uiAmount);
      } else {
        // User is buying a token with SOL
        await this.mirrorTokenPurchase(tokenOut.mint, tokenOut.uiAmount);
      }
    } catch (error) {
      console.error("Error handling DEX swap:", error);
    }
  }

  analyzeBalanceChanges(preBalances, postBalances) {
    const changes = [];

    // Create maps of pre and post balances
    const preMap = new Map(
      preBalances.map((b) => [b.mint, b.uiTokenAmount.uiAmount])
    );
    const postMap = new Map(
      postBalances.map((b) => [b.mint, b.uiTokenAmount.uiAmount])
    );

    // Find decreased balance (sold token)
    for (const [mint, preBal] of preMap) {
      const postBal = postMap.get(mint) || 0;
      if (postBal < preBal) {
        changes.push({
          mint,
          uiAmount: preBal - postBal,
          type: "decrease",
        });
      }
    }

    // Find increased balance (bought token)
    for (const [mint, postBal] of postMap) {
      const preBal = preMap.get(mint) || 0;
      if (postBal > preBal) {
        changes.push({
          mint,
          uiAmount: postBal - preBal,
          type: "increase",
        });
      }
    }

    return changes;
  }

  async mirrorTokenSale(tokenMint, amount) {
    try {
      const tokenBalance = this.tokenHoldings.get(tokenMint);
      if (!tokenBalance) {
        console.log(`No balance found for token ${tokenMint}`);
        return;
      }

      // Sell 100% of holdings instead of percentage
      const amountToSell = tokenBalance.uiAmount;

      // Get Jupiter quote for the swap
      const jupiterQuote = await this.getJupiterQuote(
        tokenMint,
        "SOL",
        amountToSell
      );

      if (!jupiterQuote) {
        console.log("Could not get Jupiter quote for token sale");
        return;
      }

      // Execute the swap
      await this.executeJupiterSwap(jupiterQuote);

      console.log(`Mirrored token sale for ${amountToSell} ${tokenMint}`);
    } catch (error) {
      console.error("Error mirroring token sale:", error);
    }
  }

  async mirrorTokenPurchase(tokenMint, amount) {
    try {
      // Get main wallet SOL balance
      const solBalance = await connection.getBalance(mainWallet.publicKey);

      // Calculate SOL amount to use based on percentage
      const solToUse =
        (solBalance * this.solPercentage) / 100 / LAMPORTS_PER_SOL;

      // Get Jupiter quote for the swap
      const jupiterQuote = await this.getJupiterQuote(
        "SOL",
        tokenMint,
        solToUse
      );

      if (!jupiterQuote) {
        console.log("Could not get Jupiter quote for token purchase");
        return;
      }

      // Execute the swap
      await this.executeJupiterSwap(jupiterQuote);

      console.log(`Mirrored token purchase with ${solToUse} SOL`);
    } catch (error) {
      console.error("Error mirroring token purchase:", error);
    }
  }

  async getJupiterQuote(inputMint, outputMint, amount) {
    try {
      // Convert 'SOL' to native SOL mint address
      const inputMintAddress =
        inputMint === "SOL"
          ? "So11111111111111111111111111111111111111112"
          : inputMint;

      const outputMintAddress =
        outputMint === "SOL"
          ? "So11111111111111111111111111111111111111112"
          : outputMint;

      // Convert amount to proper format (integer for lamports if SOL)
      const adjustedAmount =
        inputMint === "SOL"
          ? Math.floor(amount * LAMPORTS_PER_SOL).toString()
          : Math.floor(amount).toString();

      console.log(`Requesting Jupiter quote:
      Input: ${inputMint} (${inputMintAddress})
      Output: ${outputMint} (${outputMintAddress})
      Amount: ${amount} (adjusted: ${adjustedAmount})`);

      const url =
        `https://quote-api.jup.ag/v4/quote?` +
        `inputMint=${inputMintAddress}&` +
        `outputMint=${outputMintAddress}&` +
        `amount=${adjustedAmount}&` +
        `slippageBps=50`;

      console.log("Request URL:", url);

      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 404) {
          console.log("Jupiter quote not available, trying Raydium...");
          return await this.getRaydiumQuote(
            inputMintAddress,
            outputMintAddress,
            adjustedAmount
          );
        }
        const errorText = await response.text();
        console.error(`Jupiter API error (${response.status}):`, errorText);
        throw new Error(
          `Jupiter API error: ${response.statusText} (${response.status})\n${errorText}`
        );
      }

      const data = await response.json();

      if (!data || !data.data) {
        console.error("Invalid Jupiter API response:", data);
        throw new Error("Invalid response from Jupiter API");
      }

      console.log(`Successfully got Jupiter quote:
      Input Amount: ${data.data.inputAmount}
      Output Amount: ${data.data.outputAmount}
      Price Impact: ${data.data.priceImpactPct}%`);

      return {
        ...data.data,
        source: "jupiter",
      };
    } catch (error) {
      console.error("Error getting Jupiter quote:", error);
      if (error.response) {
        try {
          const errorBody = await error.response.text();
          console.error("Response body:", errorBody);
        } catch (e) {
          console.error("Could not read error response body:", e);
        }
      }
      return null;
    }
  }

  async getRaydiumQuote(inputMint, outputMint, amount) {
    try {
      // Get pool information from Raydium
      const poolResponse = await fetch("https://api.raydium.io/v2/main/pairs");
      if (!poolResponse.ok) {
        throw new Error(`Raydium API error: ${poolResponse.statusText}`);
      }

      const pools = await poolResponse.json();
      const pool = pools.find(
        (p) =>
          (p.baseMint === inputMint && p.quoteMint === outputMint) ||
          (p.baseMint === outputMint && p.quoteMint === inputMint)
      );

      if (!pool) {
        console.log("No Raydium pool found for this pair");
        return null;
      }

      // Use tokenAmountCoin and tokenAmountPc as reserves
      if (!pool.tokenAmountCoin || !pool.tokenAmountPc) {
        console.log("Invalid pool reserves:", pool);
        return null;
      }

      // Convert floating point numbers to integers (multiply by 1e9 for 9 decimals precision)
      const PRECISION = 1000000000;
      const baseReserve = Math.floor(
        parseFloat(pool.tokenAmountCoin) * PRECISION
      ).toString();
      const quoteReserve = Math.floor(
        parseFloat(pool.tokenAmountPc) * PRECISION
      ).toString();

      // Calculate expected output based on pool data
      const isBaseToQuote = pool.baseMint === inputMint;
      const inputAmount = BigInt(amount);
      const poolSupply = isBaseToQuote
        ? BigInt(baseReserve)
        : BigInt(quoteReserve);
      const outputSupply = isBaseToQuote
        ? BigInt(quoteReserve)
        : BigInt(baseReserve);

      // Simple constant product formula with 0.3% fee
      const fee = (inputAmount * BigInt(3)) / BigInt(1000); // 0.3% fee
      const inputWithFee = inputAmount - fee;
      const outputAmount =
        (inputWithFee * outputSupply) / (poolSupply + inputWithFee);

      console.log(`Successfully got Raydium quote:
      Input Amount: ${amount}
      Output Amount: ${outputAmount.toString()}
      Pool: ${pool.ammId}
      Base Reserve: ${baseReserve}
      Quote Reserve: ${quoteReserve}
      Price: ${pool.price}`);

      return {
        inputAmount: amount,
        outputAmount: outputAmount.toString(),
        priceImpactPct: ((inputAmount * BigInt(100)) / poolSupply).toString(),
        source: "raydium",
        poolId: pool.ammId,
      };
    } catch (error) {
      console.error("Error getting Raydium quote:", error);
      if (error instanceof Error && error.message.includes("BigInt")) {
        console.error("BigInt conversion error. Input values:", {
          amount,
          pool: pools?.find(
            (p) =>
              (p.baseMint === inputMint && p.quoteMint === outputMint) ||
              (p.baseMint === outputMint && p.quoteMint === inputMint)
          ),
        });
      }
      return null;
    }
  }

  async executeRaydiumSwap(quoteResponse) {
    try {
      console.log("Executing Raydium swap with quote:", quoteResponse);

      // Get pool information
      const poolResponse = await fetch("https://api.raydium.io/v2/main/pairs");
      if (!poolResponse.ok) {
        throw new Error("Failed to fetch pool information");
      }

      const pools = await poolResponse.json();
      const pool = pools.find((p) => p.ammId === quoteResponse.poolId);

      if (!pool) {
        throw new Error("Pool not found");
      }

      // Validate pool data
      const requiredFields = [
        "ammId",
        "ammAuthority",
        "lpMint",
        "lpVault",
        "baseVault",
        "quoteVault",
        "feeAccount",
      ];

      const missingFields = requiredFields.filter((field) => !pool[field]);
      if (missingFields.length > 0) {
        console.error(
          "Pool data validation failed. Missing fields:",
          missingFields
        );
        console.error("Pool data:", pool);
        throw new Error(
          `Missing required pool fields: ${missingFields.join(", ")}`
        );
      }

      // Create transaction
      const transaction = new Transaction();

      // Get or create associated token accounts
      const inputMint = new PublicKey(pool.baseMint);
      const outputMint = new PublicKey(pool.quoteMint);

      const inputATA = await getAssociatedTokenAddress(
        inputMint,
        mainWallet.publicKey
      );

      const outputATA = await getAssociatedTokenAddress(
        outputMint,
        mainWallet.publicKey
      );

      // Check if ATAs exist, if not create them
      try {
        await connection.getAccountInfo(inputATA);
      } catch {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            mainWallet.publicKey,
            inputATA,
            mainWallet.publicKey,
            inputMint
          )
        );
      }

      try {
        await connection.getAccountInfo(outputATA);
      } catch {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            mainWallet.publicKey,
            outputATA,
            mainWallet.publicKey,
            outputMint
          )
        );
      }

      // Add Raydium swap instruction
      const RAYDIUM_PROGRAM_ID = new PublicKey(
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
      );

      console.log("Creating pool account PublicKeys with data:", {
        ammId: pool.ammId,
        ammAuthority: pool.ammAuthority,
        lpMint: pool.lpMint,
        lpVault: pool.lpVault,
        baseVault: pool.baseVault,
        quoteVault: pool.quoteVault,
        feeAccount: pool.feeAccount,
      });

      // Get all the required pool accounts
      const ammId = new PublicKey(pool.ammId);
      const ammAuthority = new PublicKey(pool.ammAuthority);
      const poolTokenMint = new PublicKey(pool.lpMint);
      const poolTokenVault = new PublicKey(pool.lpVault);
      const baseTokenVault = new PublicKey(pool.baseVault);
      const quoteTokenVault = new PublicKey(pool.quoteVault);
      const feeAccount = new PublicKey(pool.feeAccount);

      const swapInstruction = new TransactionInstruction({
        programId: RAYDIUM_PROGRAM_ID,
        keys: [
          // AMM accounts
          { pubkey: ammId, isSigner: false, isWritable: true },
          { pubkey: ammAuthority, isSigner: false, isWritable: false },
          { pubkey: mainWallet.publicKey, isSigner: true, isWritable: false },
          { pubkey: poolTokenMint, isSigner: false, isWritable: true },
          { pubkey: poolTokenVault, isSigner: false, isWritable: true },
          { pubkey: baseTokenVault, isSigner: false, isWritable: true },
          { pubkey: quoteTokenVault, isSigner: false, isWritable: true },
          { pubkey: feeAccount, isSigner: false, isWritable: true },

          // User accounts
          { pubkey: inputATA, isSigner: false, isWritable: true },
          { pubkey: outputATA, isSigner: false, isWritable: true },

          // Program IDs
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([
          2, // Swap instruction
          ...new Uint8Array(
            new BigInt64Array([BigInt(quoteResponse.inputAmount)]).buffer
          ),
          ...new Uint8Array(
            new BigInt64Array([
              BigInt(Math.floor(Number(quoteResponse.outputAmount) * 0.995)),
            ]).buffer
          ), // Minimum output with 0.5% slippage
        ]),
      });

      transaction.add(swapInstruction);

      // Set recent blockhash and sign transaction
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.feePayer = mainWallet.publicKey;

      transaction.sign(mainWallet);

      // Send transaction
      const txid = await rateLimiter.enqueueRequest(() =>
        connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: true,
        })
      );

      console.log(`Raydium swap transaction sent: ${txid}`);

      // Wait for confirmation with retries
      let confirmed = false;
      let retries = 0;

      while (!confirmed && retries < RATE_LIMIT.MAX_RETRIES) {
        try {
          console.log(
            `Retry ${retries + 1}/${
              RATE_LIMIT.MAX_RETRIES
            } confirming transaction ${txid}`
          );
          await rateLimiter.enqueueRequest(() =>
            connection.confirmTransaction({
              signature: txid,
              blockhash: blockhash,
              lastValidBlockHeight: lastValidBlockHeight,
            })
          );
          confirmed = true;
          console.log(`Raydium swap transaction confirmed: ${txid}`);
        } catch (error) {
          retries++;
          if (retries === RATE_LIMIT.MAX_RETRIES) {
            throw error;
          }
          await delay(1000); // Wait 1 second before retrying
        }
      }

      return txid;
    } catch (error) {
      console.error("Error executing Raydium swap:", error);
      if (error.response) {
        try {
          const errorBody = await error.response.text();
          console.error("Raydium API error response:", errorBody);
        } catch (e) {
          console.error("Could not read error response body:", e);
        }
      }
      throw error;
    }
  }

  async updateDatabase() {
    try {
      const { error } = await supabase
        .from("trackers")
        .update({
          last_transaction: this.lastTransaction,
          updated_at: new Date().toISOString(),
        })
        .eq("id", this.id);

      if (error) {
        throw error;
      }
    } catch (error) {
      console.error(`Error updating database for tracker ${this.id}:`, error);
    }
  }

  cleanup() {
    if (this.accountSubscription) {
      connection.removeAccountChangeListener(this.accountSubscription);
      this.accountSubscription = null;
    }
  }
}

async function initializeTrackers() {
  try {
    console.log("Initializing all active trackers...");

    // Fetch all active trackers from database
    const { data: trackers, error } = await supabase
      .from("trackers")
      .select("*")
      .eq("is_active", true);

    if (error) {
      throw error;
    }

    // Clear existing trackers
    for (const tracker of activeTrackers.values()) {
      tracker.cleanup();
    }
    activeTrackers.clear();

    // Initialize new trackers
    for (const tracker of trackers) {
      try {
        const walletTracker = new WalletTracker(
          tracker.id,
          tracker.wallet_address,
          tracker.sol_percentage
        );

        await walletTracker.initialize();
        activeTrackers.set(tracker.id, walletTracker);

        console.log(`Tracker ${tracker.id} initialized successfully`);
      } catch (error) {
        console.error(`Failed to initialize tracker ${tracker.id}:`, error);
      }
    }

    console.log(`Initialized ${activeTrackers.size} trackers`);
  } catch (error) {
    console.error("Error initializing trackers:", error);
  }
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    activeTrackers: activeTrackers.size,
    rateLimiterStatus: {
      availableTokens: Math.floor(rateLimiter.tokens),
      queueLength: rateLimiter.requestQueue.length,
    },
  });
});

// Initialize trackers and start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeTrackers();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    // Reinitialize trackers every hour to ensure everything is in sync
    setInterval(initializeTrackers, 60 * 60 * 1000);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
