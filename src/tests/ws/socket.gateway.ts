import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
    cors: { origin: '*' }, // povolit připojení z FE
})
export class SocketGateway {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(SocketGateway.name);

    /**
     * Klient se připojí a řekne svoje socketId (alias)
     */
    @SubscribeMessage('register')
    handleRegister(@MessageBody() data: { socketId: string }, @ConnectedSocket() client: Socket) {
        client.join(data.socketId);
        this.logger.log(`Client registered with socketId=${data.socketId}`);
        return { ok: true };
    }

    /**
     * Progress emit – můžeš volat z TestsService
     */
    emitProgress(socketId: string, payload: { percent: number; msg: string }) {
        this.logger.log(`Emit progress to ${socketId}: ${payload.percent}% ${payload.msg}`);
        this.server.to(socketId).emit('progress', payload);
    }
}
