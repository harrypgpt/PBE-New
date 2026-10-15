import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';

/** Root module. Business modules (src/modules/*) are registered here from Stage 3 onward. */
@Module({ imports: [HealthModule] })
export class AppModule {}
