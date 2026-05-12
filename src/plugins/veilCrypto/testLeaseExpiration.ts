/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Test utility for simulating trusted unlock lease expiration.
 *
 * Usage in Discord DevTools console:
 *
 * 1. Import the test utility:
 *    const { VeilLeaseTest } = Vencord.Plugins.plugins.VeilCrypto;
 *
 * 2. Check current lease state:
 *    await VeilLeaseTest.checkLeaseState();
 *
 * 3. Force lease to expire (sets expiresAt to past):
 *    await VeilLeaseTest.expireLease();
 *
 * 4. Try to use crypto operations (should fail and require re-auth):
 *    const { cryptoService } = Vencord.Plugins.plugins.VeilCrypto;
 *    await cryptoService.sign("test message");
 *
 * 5. Restore normal lease (30 days):
 *    await VeilLeaseTest.restoreLease();
 */

import { cryptoService } from "./service";

export class VeilLeaseTest {
    /**
     * Check the current trusted unlock lease state.
     */
    static async checkLeaseState() {
        const state = await cryptoService.keyStorage.getTrustedUnlockState();
        if (!state) {
            console.log("[VeilLeaseTest] No trusted unlock state found");
            return null;
        }

        const now = Date.now();
        const expiresAt = Number(state.expiresAt);
        const isExpired = expiresAt <= now;
        const timeRemaining = isExpired ? 0 : expiresAt - now;
        const daysRemaining = Math.floor(timeRemaining / (24 * 60 * 60 * 1000));
        const hoursRemaining = Math.floor((timeRemaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

        console.log("[VeilLeaseTest] Lease state:", {
            format: state.format,
            version: state.version,
            createdAt: new Date(state.createdAt).toISOString(),
            lastRefreshedAt: new Date(state.lastRefreshedAt).toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            isExpired,
            timeRemaining: isExpired ? "EXPIRED" : `${daysRemaining}d ${hoursRemaining}h`
        });

        return state;
    }

    /**
     * Force the trusted unlock lease to expire by setting expiresAt to the past.
     * This simulates what happens when the 30-day lease naturally expires.
     */
    st async expireLease() {
        const state = await cryptoService.keyStor) {
            console.error("[VeilLeaseTest] No trusted unlock state found - nothing to expire");
            return false;
        }

        // Set expiration to 1 hour ago
        const expiredState = {
            ...state,
            expiresAt: Date.now() - (xpected behavior: operations will fail until you re-authenticate");

        return true;
    }

    /**
     * Restore the trusted unlock lease to 30 days from now.
     */
    static async restoreLease() {
        const state = await cryptoService.keyStorage.getTrustedUnlockState();
        if (!state) {
            console.error("[VeilLeaseTest] No trusted unlock state found - nothing to restore");
            return false;
        }

        const restoredState = {
            ...state,
            lastRefreshedAt: Date.now(),
            expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
        };

        await cryptoService.keyStorage.setTrustedUnlockState(restoredState);
        console.log("[VeilLeaseTest] ✓ Lease restored to 30 days");

        return true;
    }

    /**
     * Set a custom lease duration for testing.
     * @param seconds - Number of seconds until expiration
     */
    static async setCustomLeaseDuration(seconds: number) {
        const state = await cryptoService.keyStorage.getTrustedUnlockState();
        if (!state) {
            console.error("[VeilLeaseTest] No trusted unlock state found");
            return false;
        }

        const customState = {
            ...state,
            lastRefreshedAt: Date.now(),
            expiresAt: Date.now() + (seconds * 1000)
        };

        await cryptoService.keyStorage.setTrustedUnlockState(customState);
        console.log(`[VeilLeaseTest] ✓ Lease set to expire in ${seconds} seconds`);

        return true;
    }

    /**
     * Test what happens when the lease expires during normal operations.
     * Sets lease to expire in 5 seconds, then tries to sign a message after 6 seconds.
     */
    static async testLeasation() {
        await this.setCustomLeaseDuration(5);
        console.log("[VeilLeaseTest] Lease will expire in 5 seconds...");

        // Try signing immediately (should work)
        try {
            await cryptoService.sign("test before expiration");
            console.log("[VeilLeaseTest] ✓ Sign operation succeeded (lease still valid)");
        } catch (e: any) {
            consoTimeout(resolve, 6000));

        // Try signing after expiration (should fail)
        try {
            await cryptoService.sign("test after expiration");
            console.error("[VeilLeaseTest] ✗ Sign operation succeeded when it should have failed!");
        } catch (e: any) {
            console.log("[VeilLeaseTest] ✓ Sign operation failed as expected:", e.message);
        }

        // Restore lease
        await this.restoreLease();
        console.log("[VeilLeaseTest] Test complete. Lease restored.");
    }

    /**
     * Clear all crypto state (for testing fresh initialization).
     * WARNING: This will log you out of Veil!
     */
    static async clearAllState() {
        const confirmed = confirm(
            "This will clear ALL Veil crypto state and log you out. " +
            "Make sure you have a backup of your key! Continue?"
        );

        if (!confirmed) {
            console.log("[VeilLeaseTest] Cancelled");
            return false;
        }

        await cryptoService.clearStoredKey();
        console.log("[VeilLeaseTest] ✓ All crypto state cleared");

        return true;
    }
}

// Expose to window for console access
if (typeof window !== "undefined") {
    (window as any).VeilLeaseTest = seTest;
}
