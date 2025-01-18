import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Jupiter } from '@jup-ag/core';
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, getAccount } from '@solana/spl-token';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Solana connection (using mainnet for production)
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Initialize Jupiter for swaps
const jupiter = await Jupiter.load({
  connection,
  cluster: 'mainnet-beta',
  user: null // Will be set per transaction
});

// Store active trackers in memory (but persist to Supabase)
const activeTrackers = new Map();

// Load the main wallet from environment variables
const mainWalletKeypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(process.env.MAIN_WALLET_PRIVATE_KEY || '[]'))
);

class WalletTracker {
  constructor(id, walletAddress, solPercentage) {
    this.id = id;
    this.walletAddress = new PublicKey(walletAddress);
    this.solPercentage = solPercentage;
    this.isActive = true;
    this.lastTransaction = null;
    this.subscriptionId = null;
    this.tokenHoldings = new Map();
  }

  async updateInDb() {
    await supabase
      .from('trackers')
      .update({
        is_active: this.isActive,
        last_transaction: this.lastTransaction,
        updated_at: new Date().toISOString()
      })
      .eq('id', this.id);
  }

  async startTracking() {
    if (this.subscriptionId) {
      return; // Already tracking
    }

    // Subscribe to account changes
    this.subscriptionId = connection.onAccountChange(
      this.walletAddress,
      this.handleAccountChange.bind(this),
      'confirmed'
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

      // Scan for token changes
      await this.scanTokens();

      // Check for opportunities
      await this.checkOpportunities();
    } catch (error) {
      console.error('Error handling account change:', error);
    }
  }

  async scanTokens() {
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        this.walletAddress,
        { programId: TOKEN_PROGRAM_ID }
      );

      // Update token holdings map
      this.tokenHoldings.clear();
      for (const { account, pubkey } of tokenAccounts.value) {
        const { mint, amount } = account.data.parsed.info;
        this.tokenHoldings.set(mint, {
          amount: amount,
          address: pubkey.toBase58()
        });
      }
    } catch (error) {
      console.error('Error scanning tokens:', error);
    }
  }

  async checkOpportunities() {
    try {
      // Get main wallet SOL balance
      const mainBalance = await connection.getBalance(mainWalletKeypair.publicKey);
      const availableSOL = (mainBalance * this.solPercentage) / 100;

      // Check each token holding for opportunities
      for (const [mint, holding] of this.tokenHoldings) {
        const routes = await jupiter.computeRoutes({
          inputMint: new PublicKey(mint),
          outputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
          amount: holding.amount,
          slippageBps: 50, // 0.5%
        });

        if (routes.length > 0) {
          const bestRoute = routes[0];
          // If profit opportunity exists (e.g., > 1% after fees)
          if (bestRoute.outAmount > availableSOL * 1.01) {
            await this.executeSwap(bestRoute);
          }
        }
      }
    } catch (error) {
      console.error('Error checking opportunities:', error);
    }
  }

  async executeSwap(route) {
    try {
      const { transactions } = await jupiter.exchange({
        routeInfo: route,
        userPublicKey: mainWalletKeypair.publicKey,
      });

      // Sign and send each transaction in the sequence
      for (const { transaction, signers } of transactions) {
        transaction.sign([mainWalletKeypair, ...signers]);
        const signature = await connection.sendTransaction(transaction);
        await connection.confirmTransaction(signature);
        
        // Update last transaction
        this.lastTransaction = signature;
        await this.updateInDb();
      }
    } catch (error) {
      console.error('Error executing swap:', error);
    }
  }
}

// Load existing trackers from database on startup
async function loadTrackers() {
  const { data: trackers, error } = await supabase
    .from('trackers')
    .select('*')
    .eq('is_active', true);

  if (error) {
    console.error('Error loading trackers:', error);
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
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeTrackers: activeTrackers.size
  });
});

// Keep-alive endpoint
app.get('/keep-alive', (req, res) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.post('/api/trackers', async (req, res) => {
  try {
    const { walletAddress, solPercentage } = req.body;
    
    if (!walletAddress || !solPercentage) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Insert into database first
    const { data: tracker, error } = await supabase
      .from('trackers')
      .insert({
        wallet_address: walletAddress,
        sol_percentage: solPercentage,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Create and start tracker
    const walletTracker = new WalletTracker(tracker.id, walletAddress, solPercentage);
    await walletTracker.startTracking();
    activeTrackers.set(walletAddress, walletTracker);
    
    res.status(201).json(tracker);
  } catch (error) {
    console.error('Error creating tracker:', error);
    res.status(500).json({ error: 'Failed to create tracker' });
  }
});

app.get('/api/trackers', async (req, res) => {
  try {
    const { data: trackers, error } = await supabase
      .from('trackers')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    res.json(trackers);
  } catch (error) {
    console.error('Error fetching trackers:', error);
    res.status(500).json({ error: 'Failed to fetch trackers' });
  }
});

app.patch('/api/trackers/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const tracker = activeTrackers.get(address);
    const { isActive, solPercentage } = req.body;
    
    // Update database
    const { data: updatedTracker, error } = await supabase
      .from('trackers')
      .update({
        is_active: isActive,
        sol_percentage: solPercentage,
        updated_at: new Date().toISOString()
      })
      .eq('wallet_address', address)
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
    console.error('Error updating tracker:', error);
    res.status(500).json({ error: 'Failed to update tracker' });
  }
});

app.delete('/api/trackers/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const tracker = activeTrackers.get(address);
    
    // Delete from database
    const { error } = await supabase
      .from('trackers')
      .delete()
      .eq('wallet_address', address);

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
    console.error('Error deleting tracker:', error);
    res.status(500).json({ error: 'Failed to delete tracker' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});