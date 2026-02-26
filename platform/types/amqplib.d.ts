declare module "amqplib" {
  export type Options = {
    durable?: boolean;
  };

  export type PublishOptions = {
    persistent?: boolean;
    contentType?: string;
    messageId?: string;
  };

  export interface ConfirmChannel {
    assertQueue(queue: string, options?: Options): Promise<unknown>;
    sendToQueue(queue: string, content: Buffer, options?: PublishOptions): boolean;
    waitForConfirms(): Promise<void>;
    close(): Promise<void>;
  }

  export interface Connection {
    createConfirmChannel(): Promise<ConfirmChannel>;
    close(): Promise<void>;
  }

  export function connect(url: string): Promise<Connection>;
}
