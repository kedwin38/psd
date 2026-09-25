import { useEffect, useRef, useState } from "react";
import { ImageUp, Send } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Message } from "../lib/types";
import { Spinner } from "../components/workspace";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

/** One message bubble; its image (if any) is fetched with auth and shown full quality, downloadable. */
function MessageImage({ message, imageUrl }: { message: Message; imageUrl: string }) {
  return (
    <a className="message-image-link" href={imageUrl} download target="_blank" rel="noreferrer">
      <img src={imageUrl} alt="Attached" className="message-image" />
    </a>
  );
}

export function MessageBubble({ message, mine, imageUrl }: { message: Message; mine: boolean; imageUrl: string | null }) {
  return (
    <div className={`message-bubble ${mine ? "mine" : "theirs"}`}>
      <div className="message-meta hint">
        {message.author.displayName} · {new Date(message.createdAt).toLocaleString()}
      </div>
      {message.body && <p className="message-body">{message.body}</p>}
      {message.imageAssetId && (imageUrl ? <MessageImage message={message} imageUrl={imageUrl} /> : <Spinner />)}
    </div>
  );
}

export function useMessageImages(messages: readonly Message[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const withImages = messages.filter((m) => m.imageAssetId && !urls[m.id]);
    if (withImages.length === 0) return;
    void Promise.all(
      withImages.map(async (m) => {
        const blob = await api.blob(`/messages/${m.id}/image`);
        if (cancelled) return;
        setUrls((prev) => ({ ...prev, [m.id]: URL.createObjectURL(blob) }));
      }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);
  useEffect(() => () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

export function Composer({ onSend, disabled }: { onSend: (body: string | undefined, file: File | undefined) => Promise<void>; disabled?: boolean }) {
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() && !file) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(body.trim() || undefined, file ?? undefined);
      setBody("");
      setFile(null);
    } catch (err) {
      setError(errorText(err, "Could not send the message."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="message-composer" onSubmit={submit}>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {file && (
        <div className="message-composer-file hint">
          {file.name}
          <button type="button" className="sm ghost" onClick={() => setFile(null)}>
            Remove
          </button>
        </div>
      )}
      <div className="row">
        <textarea rows={2} placeholder="Write a message…" value={body} onChange={(e) => setBody(e.target.value)} disabled={disabled || busy} />
        <button type="button" className="icon-btn" aria-label="Attach an image" disabled={disabled || busy} onClick={() => fileInput.current?.click()}>
          <ImageUp size={16} aria-hidden="true" />
        </button>
        <button type="submit" className="primary" disabled={disabled || busy || (!body.trim() && !file)}>
          {busy ? <Spinner /> : <Send size={15} aria-hidden="true" />}
          Send
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        className="visually-hidden"
        tabIndex={-1}
        aria-label="Choose an image to attach"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          if (chosen) setFile(chosen);
        }}
      />
    </form>
  );
}
