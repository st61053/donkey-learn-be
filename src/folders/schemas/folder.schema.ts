import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
export type FolderDocument = HydratedDocument<Folder>;

@Schema({ timestamps: true })
export class Folder {
    @Prop({ required: true }) name: string;
    @Prop({ required: true, index: true }) ownerId: string;
    @Prop() color?: string;
    @Prop() icon?: string;
}
export const FolderSchema = SchemaFactory.createForClass(Folder);

FolderSchema.index({ ownerId: 1, createdAt: -1 });
