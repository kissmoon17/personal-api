// This file creates the connection to PostgreSQL
// Why: We need a single place to manage the database connection
// If we had database code everywhere, it would be messy

const { Pool } = require('pg');
require('dotenv').config();

// What is a Pool? 
// PostgreSQL connections are expensive to create
// A Pool reuses connections instead of creating new ones each time
// Why? Speed. Creating a connection takes time.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If DATABASE_URL doesn't exist (error), PostgreSQL tells us
  // This makes debugging easier
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// query() = run SQL code against the database
// Example: pool.query('SELECT * FROM commits')
module.exports = pool;