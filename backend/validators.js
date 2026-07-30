// Format cross-checks. The point of the prototype: don't just accept an upload —
// prove it actually matches the expected format, so the applicant sees it is "accurate".

// Read the real file type from magic bytes, so a .jpg renamed to .pdf is caught.
export function sniffFileType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const b = buffer;
  // PDF: "%PDF"
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  return null;
}

// Verhoeff checksum — the real algorithm UIDAI uses to validate an Aadhaar number.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function aadhaarChecksumValid(num) {
  if (!/^[0-9]{12}$/.test(num)) return false;
  let c = 0;
  const digits = num.split("").reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = D[c][P[i % 8][digits[i]]];
  return c === 0;
}

// Run every applicable check for one document and return a structured report.
export function validateUpload(doc, file, identifierValue) {
  const checks = [];
  const ext = (file.originalname.split(".").pop() || "").toLowerCase();
  const sizeMB = file.size / (1024 * 1024);

  // 1. Extension is on the accept list.
  checks.push({
    name: "File type accepted",
    passed: doc.accept.includes(ext),
    detail: doc.accept.includes(ext)
      ? `.${ext} is an accepted format.`
      : `.${ext} is not accepted. Allowed: ${doc.accept.join(", ")}.`,
  });

  // 2. Real content matches the extension (magic-byte sniff).
  const sniffed = sniffFileType(file.buffer);
  const extFamily = ext === "jpg" ? "jpeg" : ext;
  const contentOk = sniffed !== null && (sniffed === extFamily || (sniffed === "jpeg" && ext === "jpg"));
  checks.push({
    name: "File contents match extension",
    passed: contentOk,
    detail: sniffed
      ? contentOk
        ? `Verified real ${sniffed.toUpperCase()} content.`
        : `File is named .${ext} but the actual contents are ${sniffed.toUpperCase()} — likely a renamed file.`
      : "Could not recognise the file as a real PDF/JPG/PNG. It may be corrupt or a disguised file.",
  });

  // 3. Size within limit.
  checks.push({
    name: "File size within limit",
    passed: sizeMB <= doc.maxSizeMB,
    detail: `${sizeMB.toFixed(2)} MB (limit ${doc.maxSizeMB} MB).`,
  });

  // 4. Not empty.
  checks.push({
    name: "File is not empty",
    passed: file.size > 100,
    detail: file.size > 100 ? "File has content." : "File is empty or too small to be a real document.",
  });

  // 5. Identifier format (PAN / Aadhaar), when the doc has one.
  if (doc.identifier) {
    const raw = (identifierValue || "").trim().toUpperCase().replace(/\s/g, "");
    const patternOk = new RegExp(doc.identifier.pattern).test(raw);
    let passed = patternOk;
    let detail = patternOk
      ? `${doc.identifier.name} "${raw}" matches the expected format.`
      : `${doc.identifier.name} "${raw || "(blank)"}" does not match. Expected: ${doc.identifier.hint} e.g. ${doc.identifier.example}.`;

    // Extra real check for Aadhaar: Verhoeff checksum.
    if (patternOk && /aadhaar/i.test(doc.identifier.name)) {
      const checksumOk = aadhaarChecksumValid(raw);
      passed = checksumOk;
      detail = checksumOk
        ? `Aadhaar "${raw}" passes the 12-digit format AND the UIDAI checksum.`
        : `Aadhaar "${raw}" has the right length but FAILS the UIDAI checksum — it is not a valid Aadhaar number.`;
    }
    checks.push({ name: `${doc.identifier.name} format`, passed, detail });
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const accurate = checks.every((c) => c.passed);
  return {
    accurate,
    score: Math.round((passedCount / checks.length) * 100),
    passedCount,
    total: checks.length,
    checks,
  };
}
