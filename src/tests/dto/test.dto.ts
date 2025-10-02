// src/tests/dto/test.dto.ts
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import {
    McqQuestionDto,
    MsqQuestionDto,
    TfQuestionDto,
    ShortQuestionDto,
    ClozeQuestionDto,
    MatchQuestionDto,
    OrderQuestionDto,
} from './question.dto';

@ApiExtraModels(
    McqQuestionDto,
    MsqQuestionDto,
    TfQuestionDto,
    ShortQuestionDto,
    ClozeQuestionDto,
    MatchQuestionDto,
    OrderQuestionDto,
)
export class TestDto {
    @ApiProperty({ example: '68be049c0c1e702cee4cb5da' })
    _id!: string;

    @ApiProperty({ example: '68b4153b692c1d903babcbbb' })
    folderId!: string;

    @ApiProperty({ example: '68b14bbfa5b2e51ef9b2d07e' })
    uploaderId!: string;

    // ⬇️ Doplněno: název testu
    @ApiProperty({ example: 'Základy neuronových sítí' })
    title!: string;

    // ⬇️ Doplněno: délka testu v minutách
    @ApiProperty({ example: 90, description: 'Délka testu v minutách' })
    duration!: number;

    // ⬇️ Doplněno: mix typů otázek (Record<string, number>)
    @ApiProperty({
        description: 'Počet otázek podle typu',
        example: { mcq: 26, tf: 1, msq: 2, cloze: 0 },
        type: 'object',
        additionalProperties: { type: 'number' },
    })
    mix!: Record<string, number>;

    @ApiProperty({
        type: 'array',
        items: {
            oneOf: [
                { $ref: getSchemaPath(McqQuestionDto) },
                { $ref: getSchemaPath(MsqQuestionDto) },
                { $ref: getSchemaPath(TfQuestionDto) },
                { $ref: getSchemaPath(ShortQuestionDto) },
                { $ref: getSchemaPath(ClozeQuestionDto) },
                { $ref: getSchemaPath(MatchQuestionDto) },
                { $ref: getSchemaPath(OrderQuestionDto) },
            ],
        },
        example: [
            {
                type: 'mcq',
                text: 'Které tvrzení nejpřesněji popisuje topologii Hopfieldovy sítě?',
                choices: [
                    'Dopředná síť bez zpětných vazeb',
                    'Rekurentní síť v jedné vrstvě se všesměrnými spoji (bez self-loop)',
                    'Konvoluční síť se sousedními spoji',
                    'Hierarchická síť s neorientovanými spoji',
                ],
                correct: [1],
                meta: { chunkId: '68b417fd692c1d903babcc3d', fileId: '68b41744692c1d903babcbcc' },
            },
            {
                type: 'msq',
                text: 'Vyber správná tvrzení o konvolučních filtrech:',
                choices: [
                    'Sdílejí váhy napříč pozicemi.',
                    'Zvyšují počet parametrů oproti plně propojeným vrstvám.',
                    'Zachycují lokální vzory.',
                    'Vyžadují vstup fixní délky.',
                ],
                correct: [0, 2],
                meta: { chunkId: '68b417aa692c1d903babcc10', fileId: '68b41744692c1d903babcbcc' },
            },
            { type: 'tf', text: 'V dopředné vícevrstvé síti vedou vazby pouze dopředu.', truth: true },
            { type: 'short', text: 'Uveď vzorec pro aktualizaci váhy perceptronu s learning rate α.', answer: 'w_i = w_i + α · x_i · e' },
            { type: 'cloze', text: 'Algoritmus ______ minimalizuje chybu změnou vah a prahů neuronů.', gaps: ['zpětného šíření (backpropagation)'] },
            { type: 'match', text: 'Spáruj pojem s popisem:', left: ['Momentum', 'ADAM'], right: ['Přidává setrvačnost ke gradientu', 'Kombinuje moment a adaptivní učení'] },
            { type: 'order', text: 'Seřaď kroky dopředného průchodu FFNN:', items: ['Lineární kombinace', 'Aktivační funkce', 'Výpočet chyby'] },
        ],
    })
    questions!: Array<
        | McqQuestionDto
        | MsqQuestionDto
        | TfQuestionDto
        | ShortQuestionDto
        | ClozeQuestionDto
        | MatchQuestionDto
        | OrderQuestionDto
    >;

    @ApiProperty({ example: false })
    archived!: boolean;

    @ApiPropertyOptional({ example: 'gpt-5-mini' })
    model?: string;

    @ApiProperty({ type: String, example: '2025-09-07T22:18:04.428Z' })
    createdAt!: string;

    @ApiProperty({ type: String, example: '2025-09-07T22:18:04.428Z' })
    updatedAt!: string;
}
