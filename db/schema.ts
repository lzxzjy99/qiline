import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const rooms=sqliteTable('qiline_rooms',{
  code:text('code').primaryKey(),
  aTokenHash:text('a_token_hash').notNull(),
  bTokenHash:text('b_token_hash'),
  stateJson:text('state_json').notNull(),
  revision:integer('revision').notNull().default(0),
  aSeen:integer('a_seen').notNull(),
  bSeen:integer('b_seen').notNull().default(0),
  createdAt:integer('created_at').notNull(),
  updatedAt:integer('updated_at').notNull(),
  expiresAt:integer('expires_at').notNull(),
},t=>[index('qiline_rooms_expiry').on(t.expiresAt)]);
