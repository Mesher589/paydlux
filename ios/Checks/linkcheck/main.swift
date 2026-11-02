// LinkResolver attack suite, runnable without Xcode:
//
//   swiftc ios/PaydluxApprover/LinkResolver.swift ios/Checks/link-check.swift -o /tmp/linkcheck
//   /tmp/linkcheck
//
// Every case below is a link that could arrive from Mail, Messages, a QR code or
// a web page. The invariant under test is one sentence: the origin this app
// loads is never taken from the link. Anything that would put a non-desk origin
// in front of the signing key is a failure.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print((ok ? "  ok   " : "  FAIL ") + what)
    if !ok { failures += 1 }
}

func u(_ s: String) -> URL { URL(string: s)! }
func host(_ link: URL) -> String? { LinkResolver.resolve(link)?.host }
func full(_ link: URL) -> String? { LinkResolver.resolve(link)?.absoluteString }

let desk = "desk.paydlux.com"

// --- the good paths -------------------------------------------------------
check(host(u("https://desk.paydlux.com/phone/?k=abc")) == desk,
      "plain desk link accepted")
check(full(u("paydlux://desk?k=abc")) == "https://desk.paydlux.com/phone/?k=abc",
      "custom scheme rebuilt to the pinned desk")
check(LinkResolver.portalKey(in: u("https://desk.paydlux.com/phone/?k=abc")) == "abc",
      "portal key read out of a stored link")
check(LinkResolver.portalKey(in: u("https://desk.paydlux.com/phone/")) == nil,
      "link with no key yields no key")

// --- the attack: a custom scheme carrying an attacker host ----------------
// This is the whole reason the URL is rebuilt instead of parsed.
check(host(u("paydlux://evil.example/?k=abc")) == desk,
      "paydlux://evil.example still loads the desk")
check(host(u("paydlux://evil.example")) == desk,
      "paydlux://evil.example with no query still loads the desk")
check(full(u("paydlux://evil.example/?k=abc")) == "https://desk.paydlux.com/phone/?k=abc",
      "attacker host leaves no trace in the rebuilt URL")

// --- userinfo tricks: the host is what is after the @ ---------------------
check(host(u("paydlux://desk.paydlux.com@evil.example/?k=abc")) == desk,
      "paydlux://desk.paydlux.com@evil.example cannot smuggle a host")
check(host(u("https://desk.paydlux.com@evil.example/")) != desk,
      "https userinfo trick is refused")

// --- look-alike hosts -----------------------------------------------------
for look in ["evil.example", "paydlux.com", "www.paydlux.com",
             "desk.paydlux.com.evil.example", "evil-desk.paydlux.com.evil.example",
             "deskpaydlux.com", "desk.paydlux.co"] {
    check(host(u("https://\(look)/phone/?k=abc")) == nil,
          "https://\(look)/ is refused")
}
check(host(u("https://sub.desk.paydlux.com/phone/?k=abc")) == nil,
      "a subdomain of the desk is not the desk")
check(host(u("https://desk.paydlux.com:444/phone/?k=abc")) == desk,
      "same host on another port is still the pinned host (TLS + HSTS decide)")

// --- wrong schemes --------------------------------------------------------
for bad in ["http://desk.paydlux.com/phone/?k=abc",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "ftp://desk.paydlux.com/",
            "about:blank"] {
    check(LinkResolver.resolve(u(bad)) == nil, "refused: \(bad)")
}

// --- query is copied, and only the query ----------------------------------
// A paydlux link must not be able to add a path, a fragment or a host.
check(full(u("paydlux://desk/../../admin?k=abc")) == "https://desk.paydlux.com/phone/?k=abc",
      "path traversal in a paydlux link is dropped")
check((full(u("paydlux://desk?k=abc&host=evil.example")) ?? "").contains("host=evil.example"),
      "extra query items are carried (harmless: they cannot change the origin)")
check(host(u("paydlux://desk?k=abc")) == desk,
      "paydlux link with no host component still resolves to the desk")

// --- the key itself survives the rebuild ----------------------------------
let tricky = "paydlux://desk?k=a%2Fb%3Dc"
check(LinkResolver.portalKey(in: u(tricky)) == "a/b=c",
      "percent-encoded portal key survives the rebuild and decodes once")

print("")
if failures > 0 {
    print("\(failures) CHECK(S) FAILED")
    exit(1)
}
print("ALL CHECKS PASSED")
