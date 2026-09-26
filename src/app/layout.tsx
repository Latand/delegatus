import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PRODUCT_NAME } from "@/lib/brand";

import { TeamSessionGuard } from "@/components/team/TeamSessionGuard";
import { ROLE_FRAME_BOOT_SCRIPT } from "@/lib/roleFrames";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: `${PRODUCT_NAME}: run and watch Codex and Claude agents from one board`,
};

/* The on-screen keyboard shrinks the layout instead of covering it, so the
   composer of the focused pane stays visible while typing on a phone. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /* The role frame variant is an attribute the boot script sets on <html>
       before hydration (src/lib/roleFrames.ts). */
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: ROLE_FRAME_BOOT_SCRIPT }} />
      </head>
      <body className="h-dvh overflow-hidden font-sans text-[15px]">
        {children}
        <TeamSessionGuard />
      </body>
    </html>
  );
}
