import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import type { Message } from "../lib/types";
import { EmptyState, Spinner } from "../components/workspace";
import { MessageBubble, Composer, useMessageImages } from "./MessageThreadView";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

export function MessagesPage() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const imageUrls = useMessageImages(messages ?? []);

  const load = () => api.get<Message[]>("/messages/mine").then(setMessages);

  useEffect(() => {
    load().catch((err: unknown) => setError(errorText(err, "Could not load your messages.")));
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async (body: string | undefined, file: File | undefined) => {
    const form = new FormData();
    if (body) form.append("body", body);
    if (file) form.append("file", file);
    await api.upload("/messages/mine", form);
    await load();
  };

  return (
    <div className="messages-page">
      <div className="row between">
        <div>
          <h1>Contact support</h1>
          <p className="subtitle">Message an admin directly — about your downloads, a template issue, or anything else.</p>
        </div>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="message-thread">
        {messages === null && !error && (
          <div className="center-page" style={{ color: "var(--text-dim)" }}>
            <Spinner label="Loading" />
          </div>
        )}
        {messages !== null && messages.length === 0 && (
          <EmptyState icon={<MessageCircle size={20} />} title="No messages yet">
            Send a message below and an admin will get back to you here.
          </EmptyState>
        )}
        {messages?.map((m) => <MessageBubble key={m.id} message={m} mine={m.authorId === user?.id} imageUrl={imageUrls[m.id] ?? null} />)}
        <div ref={bottom} />
      </div>
      <Composer onSend={send} />
    </div>
  );
}
