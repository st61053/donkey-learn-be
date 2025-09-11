// ./schemas/test.schema.ts
import { Prop, Schema as NestSchema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

/** DB-friendly tvar otázky (TS typ jen pro pohodlí vývoje). */
export type DbQuestion =
    | { type: 'mcq' | 'msq'; text: string; choices: string[]; correct: number[]; meta?: { chunkId?: string; fileId?: string } }
    | { type: 'tf'; text: string; truth: boolean; meta?: { chunkId?: string; fileId?: string } }
    | { type: 'short'; text: string; answer: string; meta?: { chunkId?: string; fileId?: string } }
    | { type: 'cloze'; text: string; gaps: string[]; meta?: { chunkId?: string; fileId?: string } }
    | { type: 'match'; text: string; left: string[]; right: string[]; meta?: { chunkId?: string; fileId?: string } }
    | { type: 'order'; text: string; items: string[]; meta?: { chunkId?: string; fileId?: string } };

/** Sub-schema pro otázku (Mongoose). */
export const QuestionSchema = new MongooseSchema(
    {
        type: { type: String, enum: ['mcq', 'msq', 'tf', 'short', 'cloze', 'match', 'order'], required: true },
        text: { type: String, required: true },

        // variantní pole dle typu
        choices: { type: [String], default: undefined }, // mcq/msq
        correct: { type: [Number], default: undefined }, // mcq/msq
        truth: { type: Boolean, default: undefined },    // tf
        answer: { type: String, default: undefined },    // short
        left: { type: [String], default: undefined },  // match
        right: { type: [String], default: undefined },  // match
        gaps: { type: [String], default: undefined },  // cloze
        items: { type: [String], default: undefined },  // order

        meta: {
            chunkId: { type: String },
            fileId: { type: String },
        },
    },
    { _id: false }
);

/** Lehká validace podle typu (zachytí zjevné chyby). */
QuestionSchema.path('type').validate(function () {
    const q = this as any;
    switch (q.type) {
        case 'mcq':
        case 'msq':
            if (!Array.isArray(q.choices) || q.choices.length < 2) return false;
            if (!Array.isArray(q.correct) || q.correct.length < 1) return false;
            return q.correct.every((i: any) => Number.isInteger(i) && i >= 0 && i < q.choices.length);
        case 'tf':
            return typeof q.truth === 'boolean';
        case 'short':
            return typeof q.answer === 'string' && q.answer.trim().length > 0;
        case 'cloze':
            return Array.isArray(q.gaps) && q.gaps.length > 0;
        case 'match':
            return Array.isArray(q.left) && q.left.length >= 2 && Array.isArray(q.right) && q.right.length >= 2;
        case 'order':
            return Array.isArray(q.items) && q.items.length >= 2;
        default:
            return false;
    }
}, 'Invalid question payload for given type.');

@NestSchema({ timestamps: true, minimize: true })
export class Test {
    @Prop({ required: true }) folderId: string;
    @Prop({ required: true }) uploaderId: string;

    @Prop({ type: [QuestionSchema], default: [] })
    questions: DbQuestion[];

    @Prop({ default: false }) archived: boolean;
    @Prop() model?: string;

    // Volitelné:
    // @Prop() type?: 'topic' | 'final';
    // @Prop() sourceFileId?: string;
}

export type TestDocument = HydratedDocument<Test>;
export const TestSchema = SchemaFactory.createForClass(Test);

/** Index pro listování ve složce. */
TestSchema.index({ folderId: 1, uploaderId: 1, archived: 1, createdAt: -1 });

/** Čistší JSON výstup (oprava TS chyby přes Reflect.deleteProperty). */
TestSchema.set('toJSON', {
    transform(_doc: any, ret: any) {
        Reflect.deleteProperty(ret, '__v');
        return ret;
    },
});
