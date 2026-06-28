"use server";

import { redirect } from "next/navigation";
import Stripe from "stripe";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

/**
 * Lazily initialise the Stripe client so the module can be imported even
 * when Stripe keys are not configured (e.g. during the reviewer path that
 * relies on pre-seeded credits instead of real payments).
 */
function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error(
      "Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.",
    );
  }
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-04-30.basil",
  });
}

export type PriceId = "small" | "medium" | "large";

function getPriceId(priceId: PriceId): string {
  const map: Record<PriceId, string | undefined> = {
    small: env.STRIPE_SMALL_CREDIT_PACK,
    medium: env.STRIPE_MEDIUM_CREDIT_PACK,
    large: env.STRIPE_LARGE_CREDIT_PACK,
  };
  const id = map[priceId];
  if (!id) throw new Error(`Stripe price ID for "${priceId}" is not set.`);
  return id;
}

export async function createCheckoutSession(priceId: PriceId) {
  const stripe = getStripe();

  const serverSession = await auth();

  const user = await db.user.findUniqueOrThrow({
    where: {
      id: serverSession?.user.id,
    },
    select: { stripeCustomerId: true },
  });

  if (!user.stripeCustomerId) {
    throw new Error("User has no stripeCustomerId");
  }

  const session = await stripe.checkout.sessions.create({
    line_items: [{ price: getPriceId(priceId), quantity: 1 }],
    customer: user.stripeCustomerId,
    mode: "payment",
    success_url: `${env.BASE_URL}/dashboard?success=true`,
  });

  if (!session.url) {
    throw new Error("Failed to create session URL");
  }

  redirect(session.url);
}
