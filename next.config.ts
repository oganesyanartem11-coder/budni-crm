import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 7.14B-1: thumbnails / detail images накладных лежат на Vercel Blob.
  // Каждый store получает уникальный субдомен *.public.blob.vercel-storage.com.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },
};

export default nextConfig;
