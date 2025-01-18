import React, { useState, useEffect } from 'react';
import { Plus, Wallet, Activity, Settings, Trash2, Copy } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_ANON_KEY
);

interface TrackerData {
  id: string;
  wallet_address: string;
  sol_percentage: number;
  is_active: boolean;
  last_transaction?: string;
  balance?: string;
}

function App() {
  const [trackers, setTrackers] = useState<TrackerData[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTracker, setNewTracker] = useState({
    wallet_address: '',
    sol_percentage: 50
  });

  useEffect(() => {
    fetchTrackers();
    // Subscribe to realtime updates
    const subscription = supabase
      .channel('trackers_changes')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'trackers' }, 
        fetchTrackers
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const fetchTrackers = async () => {
    const { data } = await supabase
      .from('trackers')
      .select('*')
      .order('created_at', { ascending: false });
    if (data) {
      setTrackers(data);
    }
  };

  const handleAddTracker = async () => {
    if (newTracker.wallet_address) {
      const { data, error } = await supabase
        .from('trackers')
        .insert({
          wallet_address: newTracker.wallet_address,
          sol_percentage: newTracker.sol_percentage,
          is_active: true
        })
        .select()
        .single();

      if (!error && data) {
        setTrackers([data, ...trackers]);
        setShowAddModal(false);
        setNewTracker({ wallet_address: '', sol_percentage: 50 });
      }
    }
  };

  const toggleTrackerStatus = async (tracker: TrackerData) => {
    const { error } = await supabase
      .from('trackers')
      .update({ is_active: !tracker.is_active })
      .eq('id', tracker.id);

    if (!error) {
      setTrackers(trackers.map(t =>
        t.id === tracker.id ? { ...t, is_active: !t.is_active } : t
      ));
    }
  };

  const deleteTracker = async (id: string) => {
    const { error } = await supabase
      .from('trackers')
      .delete()
      .eq('id', id);

    if (!error) {
      setTrackers(trackers.filter(t => t.id !== id));
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center space-x-3">
            <Wallet className="w-8 h-8 text-purple-600" />
            <h1 className="text-2xl font-bold text-gray-800">Solana Tracker Dashboard</h1>
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center space-x-2 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition-colors"
          >
            <Plus className="w-5 h-5" />
            <span>Add Tracker</span>
          </button>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center space-x-2 text-purple-600 mb-2">
              <Activity className="w-5 h-5" />
              <h3 className="font-semibold">Active Trackers</h3>
            </div>
            <p className="text-3xl font-bold text-gray-800">
              {trackers.filter(t => t.is_active).length}
            </p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center space-x-2 text-blue-600 mb-2">
              <Copy className="w-5 h-5" />
              <h3 className="font-semibold">Total SOL Used</h3>
            </div>
            <p className="text-3xl font-bold text-gray-800">
              {trackers.reduce((acc, t) => acc + (t.is_active ? t.sol_percentage : 0), 0)}%
            </p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center space-x-2 text-green-600 mb-2">
              <Settings className="w-5 h-5" />
              <h3 className="font-semibold">Success Rate</h3>
            </div>
            <p className="text-3xl font-bold text-gray-800">98.2%</p>
          </div>
        </div>

        {/* Trackers List */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-800">Active Trackers</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {trackers.map(tracker => (
              <div key={tracker.id} className="p-6 hover:bg-gray-50 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                      <h3 className="font-medium text-gray-900">{tracker.wallet_address}</h3>
                      <span className={`px-2 py-1 text-xs rounded-full ${
                        tracker.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                      }`}>
                        {tracker.is_active ? 'Active' : 'Paused'}
                      </span>
                    </div>
                    <div className="text-sm text-gray-500 space-x-4">
                      <span>Using {tracker.sol_percentage}% of Main Wallet SOL</span>
                      {tracker.last_transaction && (
                        <span>Last Transaction: {tracker.last_transaction}</span>
                      )}
                      {tracker.balance && (
                        <span>Balance: {tracker.balance}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-3">
                    <button
                      onClick={() => toggleTrackerStatus(tracker)}
                      className={`p-2 rounded-lg ${
                        tracker.is_active 
                          ? 'text-yellow-600 hover:bg-yellow-50' 
                          : 'text-green-600 hover:bg-green-50'
                      }`}
                    >
                      <Settings className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => deleteTracker(tracker.id)}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Add Tracker Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold mb-4">Add New Tracker</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Wallet Address
                </label>
                <input
                  type="text"
                  value={newTracker.wallet_address}
                  onChange={(e) => setNewTracker({...newTracker, wallet_address: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  placeholder="Enter Solana wallet address"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  SOL Percentage
                </label>
                <input
                  type="number"
                  value={newTracker.sol_percentage}
                  onChange={(e) => setNewTracker({...newTracker, sol_percentage: Number(e.target.value)})}
                  min="1"
                  max="100"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div className="flex space-x-3">
                <button
                  onClick={handleAddTracker}
                  className="flex-1 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition-colors"
                >
                  Add Tracker
                </button>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 bg-gray-100 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;