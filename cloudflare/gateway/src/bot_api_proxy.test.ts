import { describe, expect, it } from "vitest";
import { mintBotProxyToken, verifyBotProxyToken } from "./bot_api_proxy";

describe("bot proxy tokens", () => {
  it("round-trips identity through mint/verify with dotted token", async () => {
    const secret = "s".repeat(32);
    const userId = "telegram:495589406";
    const chatId = "495589406";
    const token = await mintBotProxyToken(secret, userId, chatId);
    expect(token.startsWith("fd1.")).toBe(true);
    expect(token.includes("_")).toBe(false); // underscores broke old split
    const identity = await verifyBotProxyToken(secret, token);
    expect(identity).toEqual({
      userId,
      gatewayUserId: "495589406",
      gatewayConversationId: chatId,
    });
    expect(await verifyBotProxyToken(secret, token + "x")).toBeNull();
    expect(await verifyBotProxyToken("other-secret-other-secret-other", token)).toBeNull();
  });
});
