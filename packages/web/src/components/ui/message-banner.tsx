import { Banner } from "@nocoo/basalt/components/banner";

export type MessageBannerMsg = { type: "success" | "error" | "warning"; text: string };

interface MessageBannerProps {
  message: MessageBannerMsg | null;
  className?: string;
}

export function MessageBanner({ message, className }: MessageBannerProps) {
  if (!message) return null;
  return (
    <Banner
      variant={message.type === "error" ? "error" : message.type === "warning" ? "alert" : "default"}
      size="sm"
      description={message.text}
      {...(className ? { className } : {})}
    />
  );
}
