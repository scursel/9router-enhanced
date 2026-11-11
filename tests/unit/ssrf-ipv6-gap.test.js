import { describe, it, expect } from "vitest";
import { isPrivateIp } from "../../open-sse/translator/concerns/image.js";

describe("SSRF IPv6 predicate gap - image.js isPrivateIp", () => {
  describe("should block private/reserved addresses", () => {
    it("should block :: (unspecified address)", () => {
      expect(isPrivateIp("::")).toBe(true);
    });

    it("should block ::1 (IPv6 loopback)", () => {
      expect(isPrivateIp("::1")).toBe(true);
    });

    it("should block ::ffff:7f00:1 (IPv4-mapped loopback hex)", () => {
      expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
    });

    it("should block ::ffff:127.0.0.1 (IPv4-mapped loopback dotted)", () => {
      expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    });

    it("should block 0.0.0.0 (IPv4 unspecified)", () => {
      expect(isPrivateIp("0.0.0.0")).toBe(true);
    });

    it("should block 127.0.0.1 (IPv4 loopback)", () => {
      expect(isPrivateIp("127.0.0.1")).toBe(true);
    });

    it("should block 10.0.0.1 (private IPv4)", () => {
      expect(isPrivateIp("10.0.0.1")).toBe(true);
    });

    it("should block 172.16.0.1 (private IPv4)", () => {
      expect(isPrivateIp("172.16.0.1")).toBe(true);
    });

    it("should block 192.168.0.1 (private IPv4)", () => {
      expect(isPrivateIp("192.168.0.1")).toBe(true);
    });

    it("should block fc00:: (unique local)", () => {
      expect(isPrivateIp("fc00::")).toBe(true);
    });

    it("should block fd00:: (unique local)", () => {
      expect(isPrivateIp("fd00::")).toBe(true);
    });

    it("should block fe80:: (link-local)", () => {
      expect(isPrivateIp("fe80::")).toBe(true);
    });
  });

  describe("should allow public addresses", () => {
    it("should allow 8.8.8.8 (Google DNS)", () => {
      expect(isPrivateIp("8.8.8.8")).toBe(false);
    });

    it("should allow 1.1.1.1 (Cloudflare DNS)", () => {
      expect(isPrivateIp("1.1.1.1")).toBe(false);
    });

    it("should allow 2001:db8::1 (documentation IPv6)", () => {
      expect(isPrivateIp("2001:db8::1")).toBe(false);
    });

    it("should allow 2606:4700:4700::1111 (Cloudflare DNS IPv6)", () => {
      expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should block null/undefined", () => {
      expect(isPrivateIp(null)).toBe(true);
      expect(isPrivateIp(undefined)).toBe(true);
      expect(isPrivateIp("")).toBe(true);
    });

    it("should block invalid IPs", () => {
      expect(isPrivateIp("not-an-ip")).toBe(true);
    });
  });
});
