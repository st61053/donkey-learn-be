// src/tests/dto/question.dto.ts
import { ApiExtraModels, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class QuestionMetaDto {
    @ApiPropertyOptional({ example: '68b417fd692c1d903babcc3d' })
    chunkId?: string;

    @ApiPropertyOptional({ example: '68b41744692c1d903babcbcc' })
    fileId?: string;
}

export class McqQuestionDto {
    @ApiProperty({ enum: ['mcq'], example: 'mcq' })
    type!: 'mcq';

    @ApiProperty({ example: 'Které tvrzení nejpřesněji popisuje topologii Hopfieldovy sítě?' })
    text!: string;

    @ApiProperty({
        type: [String],
        example: [
            'Dopředná síť bez zpětných vazeb',
            'Rekurentní síť v jedné vrstvě se všesměrnými spoji (bez self-loop)',
            'Konvoluční síť se sousedními spoji',
            'Hierarchická síť s neorientovanými spoji',
        ],
    })
    choices!: string[];

    @ApiProperty({ type: [Number], example: [1] })
    correct!: number[];

    @ApiPropertyOptional({ type: () => QuestionMetaDto })
    meta?: QuestionMetaDto;
}

export class MsqQuestionDto {
    @ApiProperty({ enum: ['msq'], example: 'msq' })
    type!: 'msq';

    @ApiProperty({ example: 'Vyber správná tvrzení o konvolučních filtrech:' })
    text!: string;

    @ApiProperty({
        type: [String],
        example: [
            'Sdílejí váhy napříč pozicemi.',
            'Zvyšují počet parametrů oproti plně propojeným vrstvám.',
            'Zachycují lokální vzory.',
            'Vyžadují vstup fixní délky.',
        ],
    })
    choices!: string[];

    @ApiProperty({ type: [Number], example: [0, 2] })
    correct!: number[];

    @ApiPropertyOptional({ type: () => QuestionMetaDto })
    meta?: QuestionMetaDto;
}

export class TfQuestionDto {
    @ApiProperty({ enum: ['tf'], example: 'tf' })
    type!: 'tf';

    @ApiProperty({ example: 'V dopředné vícevrstvé síti vedou vazby pouze dopředu.' })
    text!: string;

    @ApiProperty({ example: true })
    truth!: boolean;

    @ApiPropertyOptional({ type: () => QuestionMetaDto })
    meta?: QuestionMetaDto;
}

export class ShortQuestionDto {
    @ApiProperty({ enum: ['short'], example: 'short' })
    type!: 'short';

    @ApiProperty({ example: 'Uveď vzorec pro aktualizaci váhy perceptronu s learning rate α.' })
    text!: string;

    @ApiProperty({ example: 'w_i = w_i + α · x_i · e' })
    answer!: string;

    @ApiPropertyOptional({ type: () => QuestionMetaDto })
    meta?: QuestionMetaDto;
}

export class ClozeQuestionDto {
    @ApiProperty({ enum: ['cloze'], example: 'cloze' })
    type!: 'cloze';

    @ApiProperty({ example: 'Algoritmus ______ minimalizuje chybu změnou vah a prahů neuronů.' })
    text!: string;

    @ApiProperty({ type: [String], example: ['zpětného šíření (backpropagation)'] })
    gaps!: string[];

    @ApiPropertyOptional({ type: () => QuestionMetaDto })
    meta?: QuestionMetaDto;
}

export class MatchQuestionDto {
    @ApiProperty({ enum: ['match'], example: 'match' })
    type!: 'match';

    @ApiProperty({ example: 'Spáruj pojem s popisem:' })
    text!: string;

    @ApiProperty({ type: [String], example: ['Momentum', 'ADAM'] })
    left!: string[];

    @ApiProperty({ type: [String], example: ['Přidává setrvačnost ke gradientu', 'Kombinuje moment a adaptivní učení'] })
    right!: string[];

    @ApiPropertyOptional({ type: () => QuestionMetaDto })
    meta?: QuestionMetaDto;
}

export class OrderQuestionDto {
    @ApiProperty({ enum: ['order'], example: 'order' })
    type!: 'order';

    @ApiProperty({ example: 'Seřaď kroky dopředného průchodu FFNN:' })
    text!: string;

    @ApiProperty({ type: [String], example: ['Lineární kombinace', 'Aktivační funkce', 'Výpočet chyby'] })
    items!: string[];

    @ApiPropertyOptional({ type: () => QuestionMetaDto })
    meta?: QuestionMetaDto;
}

// (Volitelné) registrace extra-modelů, když importuješ jen tento soubor.
@ApiExtraModels(
    McqQuestionDto,
    MsqQuestionDto,
    TfQuestionDto,
    ShortQuestionDto,
    ClozeQuestionDto,
    MatchQuestionDto,
    OrderQuestionDto,
    QuestionMetaDto,
)
export class QuestionDtosRegistry { }
