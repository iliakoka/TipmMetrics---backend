import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findByVerificationToken(token: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { verificationToken: token } });
  }

  async create(
    email: string,
    hashedPassword: string,
    verificationToken: string,
  ): Promise<User> {
    const user = this.usersRepository.create({
      email,
      password: hashedPassword,
      verificationToken,
      isVerified: false,
    });
    return this.usersRepository.save(user);
  }

  async markAsVerified(user: User): Promise<User> {
    user.isVerified = true;
    user.verificationToken = null;
    return this.usersRepository.save(user);
  }
}
