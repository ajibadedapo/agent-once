import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const K = ts.SyntaxKind;
const SCRIPT_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const EM_DASH = '\u2014';
const COMMENT_MESSAGE = 'comment is not allowed';
const EM_DASH_MESSAGE = 'em dash (U+2014) is not allowed';

const TOKENS_ENDING_AN_OPERAND = new Set([
  K.Identifier,
  K.PrivateIdentifier,
  K.NumericLiteral,
  K.BigIntLiteral,
  K.StringLiteral,
  K.RegularExpressionLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.TemplateTail,
  K.CloseParenToken,
  K.CloseBracketToken,
  K.CloseBraceToken,
  K.PlusPlusToken,
  K.MinusMinusToken,
  K.ThisKeyword,
  K.SuperKeyword,
  K.TrueKeyword,
  K.FalseKeyword,
  K.NullKeyword,
]);

const CONTEXTUAL_KEYWORDS_BEFORE_AN_OPERAND = new Set([K.AwaitKeyword, K.OfKeyword]);
const POSTFIX_NON_NULL = 'PostfixNonNull';
const NON_NULL_ASSERTION_TARGETS = new Set([
  K.Identifier,
  K.PrivateIdentifier,
  K.CloseParenToken,
  K.CloseBracketToken,
  K.ThisKeyword,
  POSTFIX_NON_NULL,
]);

function endsAnOperand(kind) {
  if (kind === POSTFIX_NON_NULL || TOKENS_ENDING_AN_OPERAND.has(kind)) return true;
  if (CONTEXTUAL_KEYWORDS_BEFORE_AN_OPERAND.has(kind)) return false;
  return kind >= K.FirstContextualKeyword && kind <= K.LastContextualKeyword;
}

function lineAt(text, position) {
  let line = 1;
  for (let i = 0; i < position; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function findCommentViolations(path, text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const templateBraceDepths = [];
  const violations = [];
  let previous = K.Unknown;
  for (let kind = scanner.scan(); kind !== K.EndOfFileToken; kind = scanner.scan()) {
    if (kind === K.SingleLineCommentTrivia || kind === K.MultiLineCommentTrivia) {
      violations.push({ path, line: lineAt(text, scanner.getTokenStart()), message: COMMENT_MESSAGE });
      continue;
    }
    if (kind === K.WhitespaceTrivia || kind === K.NewLineTrivia || kind === K.ShebangTrivia || kind === K.ConflictMarkerTrivia) {
      continue;
    }
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !endsAnOperand(previous)) {
      kind = scanner.reScanSlashToken();
    } else if (kind === K.TemplateHead) {
      templateBraceDepths.push(0);
    } else if (kind === K.OpenBraceToken && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1] += 1;
    } else if (kind === K.CloseBraceToken && templateBraceDepths.length > 0) {
      const depth = templateBraceDepths[templateBraceDepths.length - 1];
      if (depth === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === K.TemplateTail) templateBraceDepths.pop();
      } else {
        templateBraceDepths[templateBraceDepths.length - 1] = depth - 1;
      }
    }
    previous = kind === K.ExclamationToken && NON_NULL_ASSERTION_TARGETS.has(previous) ? POSTFIX_NON_NULL : kind;
  }
  return violations;
}

export function findEmDashViolations(path, text) {
  const violations = [];
  text.split('\n').forEach((content, index) => {
    if (content.includes(EM_DASH)) {
      violations.push({ path, line: index + 1, message: EM_DASH_MESSAGE });
    }
  });
  return violations;
}

function isScript(path) {
  return SCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function listRepositoryFiles(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  return output.split('\0').filter((path) => path.length > 0);
}

export function checkRepository(root) {
  const violations = [];
  for (const path of listRepositoryFiles(root)) {
    let buffer;
    try {
      buffer = readFileSync(resolve(root, path));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (isBinary(buffer)) continue;
    const text = buffer.toString('utf8');
    violations.push(...findEmDashViolations(path, text));
    if (isScript(path)) violations.push(...findCommentViolations(path, text));
  }
  return violations;
}

function main() {
  const violations = checkRepository(process.cwd());
  for (const violation of violations) {
    process.stdout.write(`${violation.path}:${violation.line}: ${violation.message}\n`);
  }
  process.exitCode = violations.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
