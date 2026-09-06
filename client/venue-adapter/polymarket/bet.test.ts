import type { PlatformAccount } from "@changmen/client-core/models/platformAccount";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { isPolymarketFokBuyFilled, isPolymarketOrderAccepted, polymarketProvider } from "./bet";
import {
  resetPmFokDepthBufferPrefsForTests,
  setPmFokDepthBufferPrefs,
} from "./pmFokDepthBufferMode";
import { POLYMARKET_BUILDER_CODE_DEFAULT } from "./builder";
import { POLYMARKET_CLOB_API } from "./api";
import { resetPolymarketOrderSyncForTest } from "./pmOrderSync";

const polymarketPluginGet = vi.hoisted(() => vi.fn());
const polymarketPluginPost = vi.hoisted(() => vi.fn());
const pmGetBook = vi.hoisted(() => vi.fn());
const pmGetTrades = vi.hoisted(() => vi.fn());
const pmSubmitOrder = vi.hoisted(() => vi.fn());
const saveVenueOdds = vi.hoisted(() => vi.fn());
const getVenueOddsEntry = vi.hoisted(() => vi.fn());

vi.mock("./transport", () => ({
  polymarketPluginGet,
  polymarketPluginPost,
  polymarketL2Get: (account: PlatformAccount, url: string, l2Path: string) =>
    polymarketPluginGet(url, { account, l2Path }),
}));

vi.mock("./pmClientApi", () => ({
  pmGetBook,
  pmSubmitOrder,
  pmGetTrades,
}));

vi.mock("@changmen/client-core/bridge/oddsAccess", () => ({
  saveVenueOdds,
  getVenueOddsEntry,
  readVenueOdds: () => 0,
  writeVenueOdds: () => {},
  cleanVenueOdds: () => {},
  isVenueOdds: () => false,
  updateVenueOddsLock: () => {},
  updateVenueBetLock: () => {},
  updateVenueOddsMessage: () => {},
  getVenueOddsLimit: () => undefined,
  setVenueOddsLimit: () => {},
  registerOddsAccess: () => {},
  clearOddsAccess: () => {},
}));

function accountWithToken(token: string, extra: Partial<PlatformAccount> = {}): PlatformAccount {
  return {
    provider: "Polymarket",
    gateway: POLYMARKET_CLOB_API,
    token,
    ...extra,
  } as unknown as PlatformAccount;
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mockPluginGetWithBook(
  book: Record<string, unknown>,
  tokenId = "123456789",
) {
  vi.mocked(pmGetBook).mockResolvedValue(book);
  vi.mocked(polymarketPluginGet).mockImplementation(async (url: string) => {
    if (url.includes("gamma-api.polymarket.com/markets")) {
      return [{
        clob_token_ids: JSON.stringify([tokenId]),
        outcomePrices: JSON.stringify(["0.5", "0.5"]),
      }];
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe("polymarketProvider.getBalance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(polymarketPluginGet).mockReset();
    vi.mocked(pmSubmitOrder).mockReset();
  });

  test("走 relay 服务端 L2 签名（account + l2Path）", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "54877978" });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      apiCreds: { apiKey: "key-1", secret: "c2VjcmV0", passphrase: "pass-1" },
    }), { accountId: 47 as unknown as PlatformAccount["accountId"] });

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 54.877978,
      currency: "USDT",
    });

    expect(polymarketPluginGet).toHaveBeenCalledWith(
      expect.stringContaining("/balance-allowance?asset_type=COLLATERAL"),
      { account, l2Path: "/balance-allowance" },
    );
  });

  test("uses relay L2 path to fetch collateral balance", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "123450000", allowance: "999999999" });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      signatureType: 3,
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 123.45,
      currency: "USDT",
    });

    expect(polymarketPluginGet).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(polymarketPluginGet).mock.calls[0]!;
    expect(url).toBe(`${POLYMARKET_CLOB_API}/balance-allowance?asset_type=COLLATERAL&signature_type=3`);
    expect(options).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        POLY_API_KEY: "key-1",
      }),
    }));
  });

  test("returns raw USDC balance (CNY via getExchange on account)", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "123450000" });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      signatureType: 3,
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }), { multiply: 10 });

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 123.45,
      currency: "USDT",
    });
  });

  test("accepts full base64 data copied from plugin", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "1000000" });
    const payload = {
      walletAddress: "0xdef",
      apiCreds: {
        key: "key-2",
        secret: "c2VjcmV0",
        passphrase: "pass-2",
      },
    };
    const account = accountWithToken(base64Utf8(JSON.stringify(payload)));

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 1,
      currency: "USDT",
    });
  });

  test("accepts outer plugin payload with nested token json", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "4868613" });
    const nested = {
      walletAddress: "0xCa4c007bdc8087F13141046Dc38F2f79F87cf43e",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "1",
      apiCreds: {
        apiKey: "key-nested",
        secret: "c2VjcmV0",
        passphrase: "pass-nested",
      },
    };
    const account = accountWithToken(base64Utf8(JSON.stringify({
      provider: "Polymarket",
      gateway: POLYMARKET_CLOB_API,
      referer: "https://polymarket.com/zh",
      token: JSON.stringify(nested),
    })));

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 4.868613,
      currency: "USDT",
    });

    const [url, options] = vi.mocked(polymarketPluginGet).mock.calls[0]!;
    expect(url).toBe(`${POLYMARKET_CLOB_API}/balance-allowance?asset_type=COLLATERAL&signature_type=3`);
    expect(options).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ POLY_API_KEY: "key-nested" }),
    }));
  });

  test("accepts flat official api credential json", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "2500000" });
    const account = accountWithToken(JSON.stringify({
      address: "0x123",
      key: "key-flat",
      secret: "c2VjcmV0",
      passphrase: "pass-flat",
    }));

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 2.5,
      currency: "USDT",
    });
    const [, options] = vi.mocked(polymarketPluginGet).mock.calls[0]!;
    expect(options).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ POLY_API_KEY: "key-flat" }),
    }));
  });

  test("accepts apiSecret naming from captured storage", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "3000000" });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0x456",
      apiCreds: {
        apiKey: "key-camel",
        apiSecret: "c2VjcmV0",
        passphrase: "pass-camel",
      },
    }));

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 3,
      currency: "USDT",
    });
    const [, options] = vi.mocked(polymarketPluginGet).mock.calls[0]!;
    expect(options).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ POLY_API_KEY: "key-camel" }),
    }));
  });

  test("uses balance path without query in relay l2Path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "1000000" });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      signatureType: 3,
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    await polymarketProvider.getBalance!(account);

    const [url, options] = vi.mocked(polymarketPluginGet).mock.calls[0]!;
    expect(url).toBe(`${POLYMARKET_CLOB_API}/balance-allowance?asset_type=COLLATERAL&signature_type=3`);
    expect(options).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ POLY_API_KEY: "key-1" }),
    }));
  });

  test("uses POLY_1271 directly when wallet and funder differ without explicit signature type", async () => {
    vi.mocked(polymarketPluginGet)
      .mockResolvedValueOnce({ balance: "4868613" })
      .mockResolvedValueOnce({ name: "pm-user", users: [{ id: "99" }], proxyWallet: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5" });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xCa4c007bdc8087F13141046Dc38F2f79F87cf43e",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 4.868613,
      currency: "USDT",
      venueMemberId: "99",
      venueAccountName: "pm-user",
    });

    expect(vi.mocked(polymarketPluginGet).mock.calls.map(([url]) => url)).toEqual([
      `${POLYMARKET_CLOB_API}/balance-allowance?asset_type=COLLATERAL&signature_type=3`,
      "https://gamma-api.polymarket.com/public-profile?address=0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
    ]);
  });

  test("overrides captured proxy signature type when funder differs from wallet", async () => {
    vi.mocked(polymarketPluginGet)
      .mockResolvedValueOnce({ balance: "4868613" })
      .mockResolvedValueOnce({ name: "pm-user", users: [{ id: "99" }] });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xCa4c007bdc8087F13141046Dc38F2f79F87cf43e",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "1",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    await expect(polymarketProvider.getBalance!(account)).resolves.toEqual({
      balance: 4.868613,
      currency: "USDT",
      venueMemberId: "99",
      venueAccountName: "pm-user",
    });

    expect(vi.mocked(polymarketPluginGet).mock.calls[0]![0]).toBe(
      `${POLYMARKET_CLOB_API}/balance-allowance?asset_type=COLLATERAL&signature_type=3`,
    );
  });

  test("infers POLY_1271 signature type when funder differs from wallet", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "1000000" });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      funder: "0xproxy",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    await polymarketProvider.getBalance!(account);

    const [url] = vi.mocked(polymarketPluginGet).mock.calls[0]!;
    expect(url).toBe(`${POLYMARKET_CLOB_API}/balance-allowance?asset_type=COLLATERAL&signature_type=3`);
  });

  test("accountId=0 保存前探测走客户端 L2 头，不经 relay 查 RDS", async () => {
    vi.mocked(polymarketPluginGet).mockResolvedValue({ balance: "1000000" });
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }), { accountId: 0 as unknown as PlatformAccount["accountId"] });

    await polymarketProvider.getBalance!(account);

    expect(polymarketPluginGet).toHaveBeenCalledWith(
      expect.stringContaining("/balance-allowance"),
      expect.objectContaining({
        headers: expect.objectContaining({
          POLY_API_KEY: "key-1",
          POLY_PASSPHRASE: "pass-1",
        }),
      }),
    );
    const opts = vi.mocked(polymarketPluginGet).mock.calls[0]?.[1];
    expect(opts).not.toHaveProperty("l2Path");
  });

  test("returns undefined when balance relay fails", async () => {
    vi.mocked(polymarketPluginGet).mockRejectedValue(new Error("missing api secret"));
    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      apiCreds: { apiKey: "key-1", secret: "c2VjcmV0", passphrase: "pass-1" },
    }), { accountId: 47 as unknown as PlatformAccount["accountId"] });

    await expect(polymarketProvider.getBalance!(account)).resolves.toBeUndefined();
    expect(polymarketPluginGet).toHaveBeenCalled();
  });
});

describe("polymarketProvider.betting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(polymarketPluginGet).mockReset();
    vi.mocked(pmSubmitOrder).mockReset();
    vi.mocked(pmGetBook).mockReset();
    vi.mocked(pmSubmitOrder).mockReset();
    saveVenueOdds.mockReset();
    getVenueOddsEntry.mockReset();
  });

  test("下单走 Pm_SubmitOrder", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "order-hk-1",
      status: "matched",
      takingAmount: "2000000",
      makingAmount: "1000000",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }), { accountId: 47 as unknown as PlatformAccount["accountId"] });

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 2,
      betMoney: 10,
    } as any);

    expect(result.success).toBe(true);
    expect(pmSubmitOrder).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 47 }),
      expect.objectContaining({ orderType: "FOK" }),
    );
  });

  test("uses official CLOB v2 order shape and posts through pmClientApi", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "order-1",
      status: "matched",
      takingAmount: "2000000",
      makingAmount: "1000000",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));
    const option = {
      itemId: "123456789",
      odds: 2,
      betMoney: 10,
    };

    const result = await polymarketProvider.betting!(account, option as any);

    expect(result.success).toBe(true);
    expect(pmGetBook).toHaveBeenCalledWith("123456789", POLYMARKET_CLOB_API);
    expect(pmSubmitOrder).toHaveBeenCalledOnce();

    const [, body] = vi.mocked(pmSubmitOrder).mock.calls[0]!;
    expect(body).toMatchObject({
      owner: "key-1",
      orderType: "FOK",
      deferExec: false,
      postOnly: false,
      order: {
        maker: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
        signer: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
        tokenId: "123456789",
        makerAmount: "10000000",
        takerAmount: "20000000",
        side: "BUY",
        signatureType: 3,
        timestamp: "1700000000000",
        expiration: "0",
        metadata: "0x0000000000000000000000000000000000000000000000000000000000000000",
        builder: POLYMARKET_BUILDER_CODE_DEFAULT,
      },
    });
    expect((body as any).order.signature).toEqual(expect.stringMatching(/^0x[0-9a-f]+$/));
  });

  test("uses market order price from book depth for FOK buy amount", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "5",
      neg_risk: false,
      asks: [
        { price: "0.5", size: "50" },
      ],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "order-depth",
      status: "matched",
      takingAmount: "18181900",
      makingAmount: "10000000",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));
    const option = {
      itemId: "123456789",
      odds: 2,
      betMoney: 10,
    };

    const result = await polymarketProvider.betting!(account, option as any);

    expect(result.success).toBe(true);
    expect((option as any).newOdds).toBeCloseTo(2, 4);

    const [, body] = vi.mocked(pmSubmitOrder).mock.calls[0]!;
    expect(body).toMatchObject({
      orderType: "FOK",
      order: {
        makerAmount: "10000000",
        takerAmount: "20000000",
        side: "BUY",
      },
    });
  });

  test("rejects FOK when book price exceeds detection odds cap", async () => {
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "5",
      neg_risk: false,
      asks: [{ price: "0.32", size: "100" }],
    });
    getVenueOddsEntry.mockReturnValue({
      id: "123456789",
      odds: 5,
      clobPrice: 0.2,
      isLock: false,
      betId: "cond-1",
      side: "home",
      time: 1,
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      betId: "cond-1",
      odds: 3.125,
      betMoney: 35,
      data: { detectionOdds: 5, apiBetMoney: 5 },
    } as any);

    expect(result.success).toBe(false);
    expect(result.message).toContain("盘口价高于检测价");
    expect(pmSubmitOrder).not.toHaveBeenCalled();
    expect(saveVenueOdds).toHaveBeenCalledWith(
      "Polymarket",
      expect.objectContaining({
        id: "123456789",
        clobPrice: 0.32,
      }),
      "http",
    );
  });

  test("accepts FOK when fo clobPrice matches detection odds (trunc3)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "5",
      neg_risk: false,
      asks: [{ price: "0.68", size: "5000" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "order-rounding",
      status: "matched",
      takingAmount: "7350000",
      makingAmount: "5000000",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    // 0.68 → trunc3 展示赔率 1.47（与 fo / 建腿同源）
    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 1.47,
      betMoney: 35,
      data: {
        detectionOdds: 1.47,
        detectionClobPrice: 0.68,
        apiBetMoney: 5,
      },
    } as any);

    expect(result.success).toBe(true);
    expect(pmSubmitOrder).toHaveBeenCalledOnce();
  });

  test("uses current betMoney instead of stale apiBetMoney after reconcile", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.38", size: "5000" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "order-reconcile-stake",
      status: "matched",
      takingAmount: "2630000",
      makingAmount: "1000000",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 2.632,
      betMoney: 3,
      data: {
        detectionOdds: 2.631,
        detectionClobPrice: 0.38,
        apiBetMoney: 14,
      },
    } as any);

    expect(result.success).toBe(true);
    const [, body] = vi.mocked(pmSubmitOrder).mock.calls[0]!;
    expect(Number((body as { order: { makerAmount: string } }).order.makerAmount) / 1_000_000)
      .toBeCloseTo(3, 2);
  });

  test("accepts decimal USDC stake from reconcile", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.38", size: "5000" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "order-decimal-stake",
      status: "matched",
      takingAmount: "2630000",
      makingAmount: "1142860",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 2.632,
      betMoney: 11.43,
      data: {
        detectionOdds: 2.631,
        detectionClobPrice: 0.38,
      },
    } as any);

    expect(result.success).toBe(true);
    const [, body] = vi.mocked(pmSubmitOrder).mock.calls[0]!;
    expect(Number((body as { order: { makerAmount: string } }).order.makerAmount) / 1_000_000)
      .toBe(11.43);
  });

  test("ignores stale apiBetMoney when betMoney is zero", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.38", size: "5000" }],
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 2.632,
      betMoney: 0,
      data: {
        detectionOdds: 2.631,
        detectionClobPrice: 0.38,
        apiBetMoney: 14,
      },
    } as any);

    expect(result.success).toBe(false);
    expect(pmSubmitOrder).not.toHaveBeenCalled();
  });

  test("reports minimum order size before posting too-small FOK buy", async () => {
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "12",
      neg_risk: false,
      asks: [{ price: "0.78", size: "100" }],
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }));

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 1.2821,
      betMoney: 3,
    } as any);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Polymarket 下单金额低于最小份数");
    expect(result.message).toContain("【盘口】");
    expect(result.message).toContain("最小下单份数：12");
    expect(result.message).toContain("当前盘口至少约 9.36 USDC");
    expect(pmSubmitOrder).not.toHaveBeenCalled();
  });

  test("fails when API success but status is not matched", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "order-unmatched",
      status: "unmatched",
      takingAmount: "",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: { apiKey: "key-1", secret: "c2VjcmV0", passphrase: "pass-1" },
    }));

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 2,
      betMoney: 10,
    } as any);

    expect(result.success).toBe(false);
    expect(result.message).toContain("status: unmatched");
    expect(result.message).toContain("未成交");
    expect(result.orderId).toBe("order-unmatched");
    expect(result.tip).toEqual({ pmPosted: true });
    expect(result.beginTime).toBe(1_700_000_000_000);
  });

  test("succeeds when API returns delayed with orderID (chain pending)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "0xdelayed-order",
      status: "delayed",
      takingAmount: "",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: { apiKey: "key-1", secret: "c2VjcmV0", passphrase: "pass-1" },
    }));

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 2,
      betMoney: 10,
    } as any);

    expect(result.success).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.orderId).toBe("0xdelayed-order");
    expect(result.message).toContain("待确认");
  });

  test("fails when matched but takingAmount is zero", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValueOnce({
      success: true,
      orderID: "order-empty",
      status: "matched",
      takingAmount: "0",
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
      signatureType: "3",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      apiCreds: { apiKey: "key-1", secret: "c2VjcmV0", passphrase: "pass-1" },
    }));

    const result = await polymarketProvider.betting!(account, {
      itemId: "123456789",
      odds: 2,
      betMoney: 10,
    } as any);

    expect(result.success).toBe(false);
    expect(result.message).toContain("takingAmount: 0");
  });
});

describe("isPolymarketFokBuyFilled", () => {
  test("requires success, matched status, and positive takingAmount", () => {
    expect(isPolymarketFokBuyFilled({
      success: true,
      status: "matched",
      takingAmount: "2000000",
    })).toBe(true);
    expect(isPolymarketFokBuyFilled({
      success: true,
      status: "MATCHED",
      takingAmount: "1.5",
    })).toBe(true);
    expect(isPolymarketFokBuyFilled({
      success: true,
      status: "delayed",
      takingAmount: "100",
    })).toBe(false);
    expect(isPolymarketFokBuyFilled({
      success: false,
      status: "matched",
      takingAmount: "100",
    })).toBe(false);
    expect(isPolymarketFokBuyFilled({
      success: true,
      status: "matched",
      takingAmount: "",
    })).toBe(false);
  });
});

describe("isPolymarketOrderAccepted", () => {
  test("accepts matched fills and delayed submissions with orderID", () => {
    expect(isPolymarketOrderAccepted({
      success: true,
      status: "matched",
      takingAmount: "1",
      orderID: "0x1",
    })).toBe(true);
    expect(isPolymarketOrderAccepted({
      success: true,
      status: "delayed",
      orderID: "0xdelayed",
    })).toBe(true);
    expect(isPolymarketOrderAccepted({
      success: true,
      status: "delayed",
      orderID: "",
    })).toBe(false);
    expect(isPolymarketOrderAccepted({
      success: true,
      status: "unmatched",
      orderID: "0x2",
    })).toBe(false);
  });
});

describe("polymarketProvider.checkBet", () => {
  beforeEach(() => {
    resetPmFokDepthBufferPrefsForTests();
    vi.mocked(polymarketPluginGet).mockReset();
    vi.mocked(pmGetBook).mockReset();
    saveVenueOdds.mockReset();
    getVenueOddsEntry.mockReset();
    vi.mocked(polymarketPluginGet).mockImplementation(async (url: string) => {
      if (url.includes("gamma-api.polymarket.com/markets")) {
        return [{
          clob_token_ids: JSON.stringify(["123456789"]),
          outcomePrices: JSON.stringify(["0.5", "0.5"]),
        }];
      }
      throw new Error(`unexpected url ${url}`);
    });
  });

  test("loads order book and sets executable odds within detection cap", async () => {
    vi.mocked(polymarketPluginGet).mockImplementation(async (url: string) => {
      if (url.includes("gamma-api.polymarket.com/markets")) {
        return [{
          clob_token_ids: JSON.stringify(["123456789"]),
          outcomePrices: JSON.stringify(["0.5", "0.5"]),
        }];
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.mocked(pmGetBook).mockResolvedValue({
      tick_size: "0.01",
      min_order_size: "5",
      neg_risk: false,
      asks: [{ price: "0.18", size: "100" }],
    });

    const option = {
      itemId: "123456789",
      odds: 5,
      betMoney: 5,
    };

    const out = await polymarketProvider.checkBet(
      accountWithToken("{}", { multiply: 7 }),
      option as any,
    );

    expect(out.data).toMatchObject({
      tokenId: "123456789",
      detectionOdds: 5,
      detectionMaxPrice: 0.2,
      bookPrice: 0.18,
      side: "BUY",
      bookFetchedAt: expect.any(Number),
      orderOptions: {
        tickSize: "0.01",
        minOrderSize: 5,
        negRisk: false,
        asks: [{ price: 0.18, size: 100 }],
      },
    });
    expect(out.odds).toBe(5.555);
    expect(out.checkError).toBeUndefined();
  });

  test("rejects when pm_sport shows series decided", async () => {
    const option = {
      itemId: "123456789",
      odds: 4.762,
      betMoney: 28,
      match: {
        pmSport: {
          mapScore: { home: 1, away: 2 },
          bo: 3,
          status: "running",
        },
      },
      bet: { round: 0 },
    };

    const out = await polymarketProvider.checkBet(
      accountWithToken("{}", { multiply: 7 }),
      option as any,
    );

    expect(out.data).toBeNull();
    expect(out.checkError).toContain("系列赛已决出");
    expect(polymarketPluginGet).not.toHaveBeenCalled();
  });

  test("rejects when pm_sport shows match ended", async () => {
    const option = {
      itemId: "123456789",
      odds: 4.762,
      betMoney: 28,
      match: {
        pmSport: {
          ended: true,
          mapScore: { home: 1, away: 2 },
          bo: 3,
        },
      },
      bet: { round: 0 },
    };

    const out = await polymarketProvider.betting(
      accountWithToken(JSON.stringify({
        walletAddress: "0xabc",
        privateKey: "0x" + "11".repeat(32),
        apiCreds: { apiKey: "k", secret: "s", passphrase: "p" },
      })),
      option as any,
    );

    expect(out.success).toBe(false);
    expect(out.message).toContain("比赛已结束");
    expect(polymarketPluginGet).not.toHaveBeenCalled();
  });

  test("rejects when book price is worse than detection odds", async () => {
    vi.mocked(polymarketPluginGet).mockImplementation(async (url: string) => {
      if (url.includes("gamma-api.polymarket.com/markets")) {
        return [{
          clob_token_ids: JSON.stringify(["123456789"]),
          outcomePrices: JSON.stringify(["0.5", "0.5"]),
        }];
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.mocked(pmGetBook).mockResolvedValue({
      tick_size: "0.01",
      min_order_size: "5",
      neg_risk: false,
      asks: [{ price: "0.32", size: "100" }],
    });
    getVenueOddsEntry.mockReturnValue({
      id: "123456789",
      odds: 5,
      clobPrice: 0.2,
      isLock: false,
      betId: "cond-1",
      side: "home",
      time: 1,
    });
    saveVenueOdds.mockClear();

    const option = {
      itemId: "123456789",
      betId: "cond-1",
      target: "Home",
      odds: 5,
      betMoney: 5,
    };

    const out = await polymarketProvider.checkBet(
      accountWithToken("{}", { multiply: 7 }),
      option as any,
    );

    expect(out.data).toBeNull();
    expect(out.checkError).toContain("盘口价高于检测价");
    expect(saveVenueOdds).toHaveBeenCalledWith(
      "Polymarket",
      expect.objectContaining({
        id: "123456789",
        clobPrice: 0.32,
        betId: "cond-1",
        side: "home",
        isLock: false,
      }),
      "http",
    );
  });

  test("price-above fo sync unlocks and keeps betId from fo", async () => {
    vi.mocked(pmGetBook).mockResolvedValue({
      tick_size: "0.01",
      min_order_size: "5",
      neg_risk: false,
      asks: [{ price: "0.32", size: "100" }],
    });
    getVenueOddsEntry.mockReturnValue({
      id: "123456789",
      odds: 5,
      clobPrice: 0.2,
      isLock: true,
      betId: "fo-cond",
      side: "away",
      time: 1,
    });
    saveVenueOdds.mockClear();

    const out = await polymarketProvider.checkBet(
      accountWithToken("{}", { multiply: 7 }),
      { itemId: "123456789", betId: "", odds: 5, betMoney: 5 } as any,
    );

    expect(out.checkError).toContain("盘口价高于检测价");
    expect(saveVenueOdds).toHaveBeenCalledWith(
      "Polymarket",
      expect.objectContaining({
        id: "123456789",
        clobPrice: 0.32,
        betId: "fo-cond",
        side: "away",
        // 有效 ask 必须解锁，否则 getOdds 仍为 0
        isLock: false,
      }),
      "http",
    );
  });

  test("does not rewrite fo when book ask is not worse than current fo clob", async () => {
    vi.mocked(pmGetBook).mockResolvedValue({
      tick_size: "0.01",
      min_order_size: "5",
      neg_risk: false,
      asks: [{ price: "0.32", size: "100" }],
    });
    getVenueOddsEntry.mockReturnValue({
      id: "123456789",
      odds: 3,
      clobPrice: 0.4,
      isLock: false,
      betId: "cond-1",
      side: "home",
      time: 1,
    });
    saveVenueOdds.mockClear();

    const out = await polymarketProvider.checkBet(
      accountWithToken("{}", { multiply: 7 }),
      { itemId: "123456789", betId: "cond-1", odds: 5, betMoney: 5 } as any,
    );

    expect(out.checkError).toContain("盘口价高于检测价");
    expect(saveVenueOdds).not.toHaveBeenCalled();
  });

  test("does not rewrite fo on min-size precheck failure", async () => {
    vi.mocked(pmGetBook).mockResolvedValue({
      tick_size: "0.01",
      min_order_size: "50",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });
    getVenueOddsEntry.mockReturnValue({
      id: "123456789",
      odds: 2,
      clobPrice: 0.5,
      isLock: false,
      betId: "cond-1",
      side: "home",
      time: 1,
    });
    saveVenueOdds.mockClear();

    const out = await polymarketProvider.checkBet(
      accountWithToken("{}", { multiply: 7 }),
      {
        itemId: "123456789",
        betId: "cond-1",
        odds: 2,
        betMoney: 5,
        data: { detectionClobPrice: 0.5, detectionOdds: 2 },
      } as any,
    );

    expect(out.checkError).toContain("低于最小份数");
    expect(saveVenueOdds).not.toHaveBeenCalled();
  });

  test("derives apiBetMoney from USDT betMoney after exchange", async () => {
    vi.mocked(polymarketPluginGet).mockImplementation(async (url: string) => {
      if (url.includes("gamma-api.polymarket.com/markets")) {
        return [{
          clob_token_ids: JSON.stringify(["123456789"]),
          outcomePrices: JSON.stringify(["0.5", "0.5"]),
        }];
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.mocked(pmGetBook).mockResolvedValue({
      tick_size: "0.01",
      min_order_size: "5",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });

    const option = {
      itemId: "123456789",
      odds: 2,
      betMoney: 14,
    };

    const out = await polymarketProvider.checkBet(
      accountWithToken("{}", { multiply: 10 }),
      option as any,
    );

    expect(out.data).toMatchObject({
      betMoney: 14,
      apiBetMoney: 14,
      detectionOdds: 2,
    });
  });

  describe("pmFokDepthBuffer", () => {
    function capOption(betMoney: number, asks: Array<{ price: string; size: string }>) {
      vi.mocked(pmGetBook).mockResolvedValue({
        tick_size: "0.01",
        min_order_size: "1",
        neg_risk: false,
        asks,
      });
      return {
        itemId: "123456789",
        odds: 1.818,
        betMoney,
        data: {
          detectionOdds: 1.818,
          detectionMaxPrice: 0.55,
          detectionClobPrice: 0.55,
        },
      };
    }

    test("off: 1× at best ask still passes (unchanged)", async () => {
      const out = await polymarketProvider.checkBet(
        accountWithToken("{}", { multiply: 7 }),
        capOption(10, [{ price: "0.5", size: "20" }]) as any,
      );
      expect(out.checkError).toBeUndefined();
      expect(out.data).toMatchObject({ bookPrice: 0.5, depthMultiplier: 1 });
    });

    test("on 1.5: best ask 1× fails; worse level inside cap does not count", async () => {
      setPmFokDepthBufferPrefs({ enabled: true, multiplier: 1.5 });
      const out = await polymarketProvider.checkBet(
        accountWithToken("{}", { multiply: 7 }),
        capOption(10, [
          { price: "0.5", size: "20" },
          { price: "0.54", size: "100" },
        ]) as any,
      );
      expect(out.data).toBeNull();
      expect(out.checkError).toContain("盘口深度不足");
      expect(out.checkError).toContain("× 1.5");
      expect(out.checkError).toContain("及更优");
    });

    test("on 1.5: best ask 1.5× passes at best ask", async () => {
      setPmFokDepthBufferPrefs({ enabled: true, multiplier: 1.5 });
      const out = await polymarketProvider.checkBet(
        accountWithToken("{}", { multiply: 7 }),
        capOption(10, [{ price: "0.5", size: "30" }]) as any,
      );
      expect(out.checkError).toBeUndefined();
      expect(out.data).toMatchObject({ bookPrice: 0.5, depthMultiplier: 1.5 });
    });

    test("on 1.5: 1× walks to second level; P and better counts toward X", async () => {
      setPmFokDepthBufferPrefs({ enabled: true, multiplier: 1.5 });
      const out = await polymarketProvider.checkBet(
        accountWithToken("{}", { multiply: 7 }),
        capOption(10, [
          { price: "0.5", size: "10" },
          { price: "0.54", size: "20" },
        ]) as any,
      );
      expect(out.checkError).toBeUndefined();
      expect(out.data).toMatchObject({ bookPrice: 0.54, depthMultiplier: 1.5 });
    });
  });
});

describe("polymarketProvider.getOrders", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPolymarketOrderSyncForTest();
    vi.mocked(polymarketPluginGet).mockReset();
    vi.mocked(pmGetTrades).mockReset();
  });

  test("fetches trades with L2 auth and maps to venue orders", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_100_000_000);
    vi.mocked(pmGetTrades).mockResolvedValue([{
      taker_order_id: "0xtrade-order",
      market: "0xcondition",
      side: "BUY",
      status: "TRADE_STATUS_CONFIRMED",
      size: "2000000",
      price: "0.5",
      match_time: "1700000000",
      outcome: "Team A",
    }]);
    vi.mocked(polymarketPluginGet).mockImplementation(async (url: string) => {
      if (url.includes("gamma-api.polymarket.com/markets")) {
        return [{
          condition_id: "0xcondition",
          question: "Counter-Strike: Team A vs Team B",
          sports_market_type: "child_moneyline",
          group_item_title: "Map 1 Winner",
          tags: [{ label: "cs2" }],
        }];
      }
      throw new Error(`unexpected url ${url}`);
    });

    const account = accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }), { accountId: 47 as unknown as PlatformAccount["accountId"] });

    const orders = await polymarketProvider.getOrders!(account);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      provider: "Polymarket",
      orderId: "0xtrade-order",
      status: "none",
      betMoney: 6.7,
      odds: 2,
    });

    expect(pmGetTrades).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 47 }),
      expect.any(Number),
      expect.any(Number),
    );
  });

  test("scales mapped order amounts to CNY display via USDT exchange", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_100_000_000);
    vi.mocked(pmGetTrades).mockResolvedValue([{
      taker_order_id: "0xtrade-order",
      market: "0xcondition",
      side: "BUY",
      status: "TRADE_STATUS_CONFIRMED",
      size: "2000000",
      price: "0.5",
      match_time: "1700000000",
      outcome: "Team A",
    }]);
    vi.mocked(polymarketPluginGet).mockImplementation(async (url: string) => {
      if (url.includes("gamma-api.polymarket.com/markets")) {
        return [{
          condition_id: "0xcondition",
          question: "Counter-Strike: Team A vs Team B",
          sports_market_type: "child_moneyline",
          group_item_title: "Map 1 Winner",
          tags: [{ label: "cs2" }],
        }];
      }
      throw new Error(`unexpected url ${url}`);
    });

    const orders = await polymarketProvider.getOrders!(accountWithToken(JSON.stringify({
      walletAddress: "0xabc",
      apiCreds: {
        apiKey: "key-1",
        secret: "c2VjcmV0",
        passphrase: "pass-1",
      },
    }), { accountId: 47 as unknown as PlatformAccount["accountId"], multiply: 10 }));

    expect(orders[0]?.betMoney).toBe(6.7);
    expect(orders[0]?.reward).toBe(13.4);
  });

  test("returns empty array when credentials are missing", async () => {
    vi.mocked(pmGetTrades).mockRejectedValue(new Error("missing credentials"));
    const orders = await polymarketProvider.getOrders!(accountWithToken("{}", { accountId: 47 as unknown as PlatformAccount["accountId"] }));
    expect(orders).toEqual([]);
    expect(pmGetTrades).toHaveBeenCalled();
  });
});

function pmBettingAccount() {
  return accountWithToken(JSON.stringify({
    walletAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    funder: "0x8ed24e533d24c2f381983eda8f97c2358f8d65e5",
    signatureType: "3",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    apiCreds: {
      apiKey: "key-1",
      secret: "c2VjcmV0",
      passphrase: "pass-1",
    },
  }));
}

function bookGetCalls() {
  return vi.mocked(pmGetBook).mock.calls;
}

describe("PM precheck /book reuse", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(polymarketPluginGet).mockReset();
    vi.mocked(pmSubmitOrder).mockReset();
  });

  test("betting reuses checkBet /book within TTL", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValue({
      success: true,
      orderID: "order-reuse",
      status: "matched",
      takingAmount: "2000000",
      makingAmount: "1000000",
    });

    const account = pmBettingAccount();
    const option = {
      itemId: "123456789",
      odds: 2,
      betMoney: 10,
    };

    const checked = await polymarketProvider.checkBet!(account, option as any);
    expect(checked.data).toBeTruthy();
    expect(bookGetCalls().length).toBeGreaterThan(0);

    vi.mocked(pmGetBook).mockClear();
    const result = await polymarketProvider.betting!(account, checked as any);

    expect(result.success).toBe(true);
    expect(bookGetCalls()).toHaveLength(0);
  });

  test("betting refetches /book when precheck cache expired", async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockPluginGetWithBook({
      tick_size: "0.01",
      min_order_size: "1",
      neg_risk: false,
      asks: [{ price: "0.5", size: "100" }],
    });
    vi.mocked(pmSubmitOrder).mockResolvedValue({
      success: true,
      orderID: "order-refetch",
      status: "matched",
      takingAmount: "2000000",
      makingAmount: "1000000",
    });

    const account = pmBettingAccount();
    const option = {
      itemId: "123456789",
      odds: 2,
      betMoney: 10,
    };

    const checked = await polymarketProvider.checkBet!(account, option as any);
    expect(checked.data).toBeTruthy();

    now += 801;
    vi.mocked(pmGetBook).mockClear();
    const result = await polymarketProvider.betting!(account, checked as any);

    expect(result.success).toBe(true);
    expect(bookGetCalls().length).toBeGreaterThan(0);
  });
});
