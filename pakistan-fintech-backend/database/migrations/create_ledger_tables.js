// backend/database/migrations/create_ledger_tables.js
exports.up = async function(knex) {
  // 1. Accounts table (wallet accounts)
  await knex.schema.createTable('accounts', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable();
    table.enum('account_type', ['customer_wallet', 'company_operational', 'settlement']).notNullable();
    table.decimal('balance', 19, 4).defaultTo(0).notNullable();
    table.string('currency', 3).defaultTo('PKR');
    table.enum('status', ['active', 'frozen', 'closed']).defaultTo('active');
    table.timestamps(true, true);
    table.index('user_id');
  });

  // 2. Ledger entries (immutable transaction log)
  await knex.schema.createTable('ledger_entries', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('transaction_ref').notNullable().unique(); // SBP required TRN
    table.uuid('account_id').notNullable();
    table.enum('entry_type', ['debit', 'credit']).notNullable();
    table.decimal('amount', 19, 4).notNullable();
    table.decimal('balance_after', 19, 4).notNullable(); // Running balance
    table.string('currency', 3).defaultTo('PKR');
    table.jsonb('metadata'); // Store additional info
    table.timestamp('created_at').defaultTo(knex.raw('CURRENT_TIMESTAMP')).notNullable();
    
    // Indexes for performance
    table.index(['account_id', 'created_at']);
    table.index('transaction_ref');
    table.index('created_at');
  });

  // 3. Transactions table (groups related ledger entries)
  await knex.schema.createTable('transactions', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('transaction_ref').notNullable().unique();
    table.enum('type', ['transfer', 'deposit', 'withdrawal', 'remittance']).notNullable();
    table.uuid('from_account_id');
    table.uuid('to_account_id');
    table.decimal('amount', 19, 4).notNullable();
    table.string('currency', 3).defaultTo('PKR');
    table.enum('status', ['pending', 'completed', 'failed', 'reversed']).defaultTo('pending');
    table.jsonb('metadata');
    table.timestamps(true, true);
  });
};
