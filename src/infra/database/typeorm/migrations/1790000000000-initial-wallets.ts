import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialWallets1790000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE wallets (
      id uuid PRIMARY KEY,
      player_id uuid NOT NULL,
      currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      balance numeric(20,2) NOT NULL CHECK (balance >= 0),
      version integer NOT NULL CHECK (version >= 1),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (player_id, currency)
    )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE wallets');
  }
}
