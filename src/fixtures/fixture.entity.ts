import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Tip } from '../tips/tip.entity';

@Entity('fixtures')
export class Fixture {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, type: 'bigint' })
  apiFixtureId: number;

  @Column({ type: 'int' })
  leagueId: number;

  @Column()
  leagueName: string;

  @Column({ nullable: true })
  leagueCountry: string;

  @Column({ type: 'int' })
  homeTeamId: number;

  @Column()
  homeTeamName: string;

  @Column({ nullable: true })
  homeTeamLogo: string;

  @Column({ type: 'int' })
  awayTeamId: number;

  @Column()
  awayTeamName: string;

  @Column({ nullable: true })
  awayTeamLogo: string;

  @Column({ type: 'timestamptz' })
  matchDate: Date;

  @Column({ default: 'NS' })
  status: string; // 'NS' (Not Started), 'FT' (Full Time), etc.

  @Column({ type: 'int', nullable: true })
  homeGoals: number | null;

  @Column({ type: 'int', nullable: true })
  awayGoals: number | null;

  @Column({ type: 'jsonb', nullable: true })
  rawOdds: Record<string, any> | null;

  @OneToMany(() => Tip, (tip) => tip.fixture)
  tips: Tip[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
