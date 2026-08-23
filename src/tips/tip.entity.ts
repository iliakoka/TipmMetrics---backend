import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Fixture } from '../fixtures/fixture.entity';

export enum TipResult {
  PENDING = 'PENDING',
  WON = 'WON',
  LOST = 'LOST',
  VOID = 'VOID',
}

@Entity('tips')
export class Tip {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  fixtureId: string;

  @ManyToOne(() => Fixture, (fixture) => fixture.tips, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'fixtureId' })
  fixture: Fixture;

  @Column({ type: 'timestamptz' })
  matchDate: Date;

  @Column()
  leagueName: string;

  @Column()
  homeTeamName: string;

  @Column()
  awayTeamName: string;

  @Column()
  market: string; // 'BTTS', 'OVER_2_5', 'HOME_WIN', 'DOUBLE_CHANCE'

  @Column()
  prediction: string; // 'Both Teams To Score: Yes', 'Over 2.5 Goals', '1X'

  @Column({ type: 'decimal', precision: 4, scale: 2 })
  odds: number; // e.g. 1.85

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  confidenceScore: number; // e.g. 78.50

  @Column({ default: false })
  isFree: boolean; // 1 free tip for daily teaser

  @Column({
    type: 'enum',
    enum: TipResult,
    default: TipResult.PENDING,
  })
  result: TipResult;

  @Column({ type: 'varchar', nullable: true })
  resultScore: string | null; // e.g. "2-1"

  @Column({ type: 'jsonb', nullable: true })
  factors: Record<string, any> | null; // Store all analytical indicators for 2-3 month backtesting

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  settledAt: Date | null;
}
