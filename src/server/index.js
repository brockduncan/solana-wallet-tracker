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
  MIN_DELAY: 10000, // Increased minimum delay between requests (10 seconds)
  MAX_DELAY: 60000, // Maximum delay for retries (60 seconds)
  MAX_RETRIES: 5, // Reduced max retries to avoid excessive waiting
  SCAN_INTERVAL: 300000, // Increased minimum interval between full scans (5 minutes)
  BATCH_SIZE: 1, // Reduced to 1 to avoid rate limits
  BATCH_DELAY: 5000, // Increased delay between batches (5 seconds)
  TOKEN_PROCESS_DELAY: 2000, // Increased delay between processing tokens (2 seconds)
};

// Enhanced logging utility
const log = {
  info: (message, data = {}) => {
    console.log(
      `[${new Date().toISOString()}] INFO: ${message}`,
      JSON.stringify(data, null, 2)
    );
  },
  error: (message, error = {}) => {
    console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error);
  },
  websocket: (message, data = {}) => {
    console.log(
      `[${new Date().toISOString()}] WEBSOCKET: ${message}`,
      JSON.stringify(data, null, 2)
    );
  },
  tracker: (address, message, data = {}) => {
    console.log(
      `[${new Date().toISOString()}] TRACKER [${address}]: ${message}`,
      JSON.stringify(data, null, 2)
    );
  },
};

// Request queue implementation with rate limiting
class RequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastProcessTime = 0;
    this.retryCount = new Map();
  }

  async add(fn, priority = false, maxRetries = RATE_LIMIT.MAX_RETRIES) {
    return new Promise((resolve, reject) => {
      const queueItem = {
        fn,
        resolve,
        reject,
        priority,
        maxRetries,
        attempts: 0,
      };
      if (priority) {
        this.queue.unshift(queueItem);
      } else {
        this.queue.push(queueItem);
      }
      this.process();
    });
  }

  async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const timeSinceLastProcess = now - this.lastProcessTime;
      if (timeSinceLastProcess < RATE_LIMIT.MIN_DELAY) {
        await delay(RATE_LIMIT.MIN_DELAY - timeSinceLastProcess);
      }

      const item = this.queue.shift();
      try {
        const result = await this.executeWithRetry(item);
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }

      this.lastProcessTime = Date.now();
      if (this.queue.length > 0) {
        await delay(RATE_LIMIT.BATCH_DELAY);
      }
    }

    this.processing = false;
  }

  async executeWithRetry({ fn, attempts, maxRetries }) {
    try {
      return await fn();
    } catch (error) {
      if (error.message?.includes("429") && attempts < maxRetries) {
        const backoff = exponentialBackoff(attempts);
        log.info(
          `Rate limited, retrying after ${backoff}ms delay (attempt ${
            attempts + 1
          }/${maxRetries})`
        );
        await delay(backoff);
        return this.executeWithRetry({
          fn,
          attempts: attempts + 1,
          maxRetries,
        });
      }
      throw error;
    }
  }
}

const requestQueue = new RequestQueue();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exponentialBackoff = (attempt) => {
  const backoff = Math.min(
    RATE_LIMIT.MIN_DELAY * Math.pow(2, attempt),
    RATE_LIMIT.MAX_DELAY
  );
  return backoff + Math.random() * 2000;
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
    this.lastScanTime = 0;
    this.isScanning = false;

    log.tracker(walletAddress, "Tracker initialized", {
      id,
      solPercentage,
      isActive: this.isActive,
    });
  }

  async updateInDb() {
    try {
      await supabase
        .from("trackers")
        .update({
          is_active: this.isActive,
          last_transaction: this.lastTransaction,
          updated_at: new Date().toISOString(),
        })
        .eq("id", this.id);

      log.tracker(this.walletAddress.toString(), "Database updated", {
        isActive: this.isActive,
        lastTransaction: this.lastTransaction,
      });
    } catch (error) {
      log.error("Failed to update tracker in database", error);
    }
  }

  async startTracking() {
    if (this.subscriptionId) {
      log.tracker(this.walletAddress.toString(), "Already tracking");
      return;
    }

    try {
      // Subscribe to account changes
      this.subscriptionId = connection.onAccountChange(
        this.walletAddress,
        async (accountInfo, context) => {
          log.websocket("Account change detected", {
            wallet: this.walletAddress.toString(),
            slot: context.slot,
            accountInfo: {
              lamports: accountInfo.lamports,
              owner: accountInfo.owner.toString(),
              executable: accountInfo.executable,
              rentEpoch: accountInfo.rentEpoch,
            },
          });
          await this.handleAccountChange(accountInfo, context);
        },
        "confirmed"
      );

      log.tracker(
        this.walletAddress.toString(),
        "Websocket subscription started",
        {
          subscriptionId: this.subscriptionId,
        }
      );

      // Initial token scan
      await this.scanTokens();
    } catch (error) {
      log.error("Failed to start tracking", error);
      throw error;
    }
  }

  async stopTracking() {
    if (this.subscriptionId) {
      try {
        await connection.removeAccountChangeListener(this.subscriptionId);
        log.tracker(
          this.walletAddress.toString(),
          "Websocket subscription stopped",
          {
            subscriptionId: this.subscriptionId,
          }
        );
        this.subscriptionId = null;
      } catch (error) {
        log.error("Failed to remove account change listener", error);
      }
    }
    this.isActive = false;
    await this.updateInDb();
  }

  async handleAccountChange(accountInfo, context) {
    try {
      log.tracker(this.walletAddress.toString(), "Processing account change", {
        slot: context.slot,
        lamports: accountInfo.lamports,
      });

      this.lastTransaction = context.slot.toString();
      await this.updateInDb();

      // Only scan tokens if enough time has passed since last scan and not currently scanning
      const now = Date.now();
      if (
        !this.isScanning &&
        now - this.lastScanTime >= RATE_LIMIT.SCAN_INTERVAL
      ) {
        await this.scanTokens();
      }

      await this.checkOpportunities();
    } catch (error) {
      log.error("Error handling account change", error);
    }
  }

  async scanTokens() {
    if (this.isScanning) {
      log.tracker(
        this.walletAddress.toString(),
        "Token scan already in progress, skipping"
      );
      return;
    }

    this.isScanning = true;
    try {
      log.tracker(this.walletAddress.toString(), "Starting token scan");

      const scanTokens = async () => {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          this.walletAddress,
          { programId: TOKEN_PROGRAM_ID }
        );
        return tokenAccounts;
      };

      const tokenAccounts = await requestQueue.add(
        () => scanTokens(),
        false, // not priority
        RATE_LIMIT.MAX_RETRIES
      );

      this.tokenHoldings.clear();
      for (const { account, pubkey } of tokenAccounts.value) {
        const { mint, amount, decimals } = account.data.parsed.info;
        this.tokenHoldings.set(mint, {
          amount: amount,
          decimals: decimals,
          address: pubkey.toBase58(),
        });

        log.tracker(this.walletAddress.toString(), "Token found", {
          mint,
          amount,
          decimals,
          address: pubkey.toBase58(),
        });
      }

      this.lastScanTime = Date.now();
      log.tracker(this.walletAddress.toString(), "Token scan completed", {
        tokenCount: this.tokenHoldings.size,
      });
    } catch (error) {
      log.error("Error scanning tokens", error);
    } finally {
      this.isScanning = false;
    }
  }
}

// Load existing trackers from database on startup
async function loadTrackers() {
  try {
    const { data: trackers, error } = await supabase
      .from("trackers")
      .select("*")
      .eq("is_active", true);

    if (error) {
      log.error("Error loading trackers from database", error);
      return;
    }

    log.info("Loading trackers from database", { count: trackers.length });

    for (const tracker of trackers) {
      const walletTracker = new WalletTracker(
        tracker.id,
        tracker.wallet_address,
        tracker.sol_percentage
      );
      await walletTracker.startTracking();
      activeTrackers.set(tracker.wallet_address, walletTracker);
    }

    log.info("Trackers loaded and started", {
      activeTrackerCount: activeTrackers.size,
    });
  } catch (error) {
    log.error("Failed to load trackers", error);
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
