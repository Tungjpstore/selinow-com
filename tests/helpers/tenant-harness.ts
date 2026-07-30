import { AppError } from "../../src/lib/core/errors";

type HarnessShop = {
  id: string;
  name: string;
  ownerUserId: string;
};

export class TenantIsolationHarness {
  readonly shops = new Map<string, HarnessShop>();

  addShop(shop: HarnessShop): void {
    this.shops.set(shop.id, { ...shop });
  }

  readShop(userId: string, shopId: string): HarnessShop {
    const shop = this.shops.get(shopId);
    if (shop === undefined || shop.ownerUserId !== userId) {
      throw new AppError("authorization_denied", 403);
    }
    return { ...shop };
  }

  updateShopName(userId: string, shopId: string, name: string): HarnessShop {
    const shop = this.readShop(userId, shopId);
    const updated = { ...shop, name };
    this.shops.set(shopId, updated);
    return { ...updated };
  }
}
