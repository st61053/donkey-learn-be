import { ApiProperty } from '@nestjs/swagger';

export type QuestionKind = 'mcq' | 'msq' | 'tf' | 'cloze' | 'short' | 'match' | 'order';

export interface BaseQuestion {
    k: QuestionKind;        // typ otázky
    t: string;              // text otázky
    s?: { c?: string };     // source metadata (např. file/chunk)
}

// MCQ: jedna správná
export interface McqQuestion extends BaseQuestion {
    k: 'mcq';
    o: string[];  // možnosti
    ci: number[]; // index(y) správných, pro mcq očekáváme 1 prvek
}

// MSQ: více správných
export interface MsqQuestion extends BaseQuestion {
    k: 'msq';
    o: string[];
    ci: number[];
}

// True/False
export interface TfQuestion extends BaseQuestion {
    k: 'tf';
    r: boolean; // správná odpověď
}

// Cloze: doplňovačka
export interface ClozeQuestion extends BaseQuestion {
    k: 'cloze';
    g: string[]; // gappy / správné doplnění
}

// Short: krátká odpověď (volný text)
export interface ShortQuestion extends BaseQuestion {
    k: 'short';
    r: string; // očekávaná krátká odpověď
}

// Match: párování
export interface MatchQuestion extends BaseQuestion {
    k: 'match';
    l: string[]; // levý sloupec
    r: string[]; // pravý sloupec (permutace)
}

// Order: seřazení
export interface OrderQuestion extends BaseQuestion {
    k: 'order';
    o: string[]; // položky k seřazení ve správném pořadí
}

export type AiQuestion =
    | McqQuestion
    | MsqQuestion
    | TfQuestion
    | ClozeQuestion
    | ShortQuestion
    | MatchQuestion
    | OrderQuestion;

export class AiResponseDto {
    @ApiProperty({ example: 'gpt-5-mini' })
    model: string;

    @ApiProperty({
        description: 'Vygenerované otázky v předepsaném JSON tvaru',
        isArray: true,
    })
    questions: AiQuestion[];
}
