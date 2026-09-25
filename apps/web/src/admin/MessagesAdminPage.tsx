import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Message, MessageThread } from "../lib/types";
import { EmptyState, Spinner } from "../components/workspace";
import { MessageBubble, Composer, useMessageImages } from "../messages/MessageThreadView";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

export function MessagesAdminPage() {
  const [threads, setThreads] = useState<MessageThread[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const imageUrls = useMessageImages(messages ?? []);

  const loadThreads = () => api.get<MessageThread[]>("/admin/messages").then(setThreads);

  useEffect(() => {
    loadThreads().catch((err: unknown) => setError(errorText(err, "Could not load conversations.")));
  }, []);

  const openThread = (userId: string) => {
    setSelected(userId);
    setMessages(null);
    api
      .get<{ user: MessageThread["user"]; messages: Message[] }>(`/admin/messages/${userId}`)
      .then((thread) => {
        setMessages(thread.messages);
        // Reading the thread marked it read server-side; reflect that without a full reload.
        setThreads((prev) => prev?.map((t) => (t.user.id === userId ? { ...t, unreadCount: 0 } : t)) ?? null);
      })
      .catch((err: unknown) => setError(errorText(err, "Could not open this conversation.")));
  };

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async (body: string | undefined, file: File | undefined) => {
    if (!selected) return;
    const form = new FormData();
    if (body) form.append("body", body);
    if (file) form.append("file", file);
    await api.upload(`/admin/messages/${selected}`, form);
    const thread = await api.get<{ user: MessageThread["user"]; messages: Message[] }>(`/admin/messages/${selected}`);
    setMessages(thread.messages);
    void loadThreads();
  };

  const selectedThread = threads?.find((t) => t.user.id === selected);

  return (
    <div className="messages-admin-page">
      <aside className="messages-thread-list" aria-label="Conversations">
        <div className="panel-header">
          <h2 className="panel-title">Conversations</h2>
        </div>
        <div className="panel-body">
          {threads === null && !error && <Spinner label="Loading" />}
          {threads !== null && threads.length === 0 && <p className="hint">No conversations yet.</p>}
          {threads?.map((t) => (
            <button key={t.user.id} type="button" className={`message-thread-row${selected === t.user.id ? " selected" : ""}`} onClick={() => openThread(t.user.id)}>
              <div className="who">
                <div>{t.user.displayName}</div>
                <div className="hint">{t.user.email}</div>
              </div>
              {t.unreadCount > 0 && (
                <span className="badge plain" aria-label={`${t.unreadCount} unread`}>
                  {t.unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      <main className="messages-admin-main">
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        {!selected && (
          <EmptyState icon={<MessageCircle size={20} />} title="Select a conversation">
            Pick a user on the left to read and reply to their messages.
          </EmptyState>
        )}
        {selected && (
          <>
            <div className="messages-admin-header">
              <h2>{selectedThread?.user.displayName ?? "Conversation"}</h2>
              <p className="hint">{selectedThread?.user.email}</p>
            </div>
            <div className="message-thread">
              {messages === null && <Spinner label="Loading" />}
              {messages?.map((m) => <MessageBubble key={m.id} message={m} mine={m.authorRole === "ADMIN"} imageUrl={imageUrls[m.id] ?? null} />)}
              <div ref={bottom} />
            </div>
            <Composer onSend={send} />
          </>
        )}
      </main>
    </div>
  );
}
