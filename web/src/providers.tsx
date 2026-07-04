// wagmi + RainbowKit providers — the EVM equivalent of the Sui dapp-kit providers.
// ConnectButton and user-signed hires need these.
import "@rainbow-me/rainbowkit/styles.css";
import type { ReactNode } from "react";
import { RainbowKitProvider, getDefaultConfig, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defineChain } from "viem";

const env = (import.meta as any).env ?? {};

export const monadTestnet = defineChain({
  id: Number(env.VITE_CHAIN_ID || 10143),
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [env.VITE_MONAD_RPC || "https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monad Explorer", url: env.VITE_EXPLORER || "https://testnet.monadexplorer.com" } },
  testnet: true,
});

// WalletConnect needs a projectId; MetaMask / injected wallets work without a real one.
// Set VITE_WALLETCONNECT_PROJECT_ID to enable WalletConnect / mobile wallets.
export const config = getDefaultConfig({
  appName: "AgentMonad",
  projectId: env.VITE_WALLETCONNECT_PROJECT_ID || "vouch_monad_demo",
  chains: [monadTestnet],
  ssr: false,
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({ accentColor: "#6366f1", borderRadius: "medium" })} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
