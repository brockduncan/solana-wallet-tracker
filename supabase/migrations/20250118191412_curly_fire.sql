/*
  # Create trackers table

  1. New Tables
    - `trackers`
      - `id` (uuid, primary key)
      - `wallet_address` (text, unique)
      - `sol_percentage` (integer)
      - `is_active` (boolean)
      - `last_transaction` (text, nullable)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

  2. Security
    - Enable RLS on `trackers` table
    - Add policies for authenticated users to manage trackers
*/

CREATE TABLE IF NOT EXISTS trackers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text UNIQUE NOT NULL,
  sol_percentage integer NOT NULL CHECK (sol_percentage > 0 AND sol_percentage <= 100),
  is_active boolean DEFAULT true,
  last_transaction text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE trackers ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read trackers
CREATE POLICY "Allow authenticated users to read trackers"
  ON trackers
  FOR SELECT
  TO authenticated
  USING (true);

-- Allow all authenticated users to insert trackers
CREATE POLICY "Allow authenticated users to insert trackers"
  ON trackers
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Allow all authenticated users to update trackers
CREATE POLICY "Allow authenticated users to update trackers"
  ON trackers
  FOR UPDATE
  TO authenticated
  USING (true);

-- Allow all authenticated users to delete trackers
CREATE POLICY "Allow authenticated users to delete trackers"
  ON trackers
  FOR DELETE
  TO authenticated
  USING (true);