import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('team_stats')
@Index(['teamId', 'leagueId'], { unique: true })
export class TeamStat {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  teamId: number;

  @Column({ type: 'int' })
  leagueId: number;

  @Column({ type: 'int', default: 2024 })
  season: number;

  @Column({ type: 'varchar', nullable: true })
  teamName: string;

  @Column({ type: 'float', default: 1.2 })
  goalsForHome: number;

  @Column({ type: 'float', default: 1.0 })
  goalsForAway: number;

  @Column({ type: 'float', default: 1.1 })
  goalsForTotal: number;

  @Column({ type: 'float', default: 1.1 })
  goalsAgainstHome: number;

  @Column({ type: 'float', default: 1.3 })
  goalsAgainstAway: number;

  @Column({ type: 'float', default: 1.2 })
  goalsAgainstTotal: number;

  @Column({ type: 'varchar', default: 'WDLW' })
  form: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
