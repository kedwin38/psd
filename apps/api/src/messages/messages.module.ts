import { Module } from "@nestjs/common";
import { MessagesController } from "./messages.controller";
import { AdminMessagesController } from "./admin-messages.controller";
import { MessagesService } from "./messages.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  controllers: [MessagesController, AdminMessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
