import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { TokenBudgetService } from './token-budget.service';

@Module({
    providers: [AiService, TokenBudgetService],
    exports: [AiService, TokenBudgetService],
})
export class AiModule { }
