from __future__ import annotations

import ast
import io
import subprocess
import sys
import tempfile
import tokenize
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

COMMENT_MESSAGE = "comment is not allowed"
DOCSTRING_MESSAGE = "docstring is not allowed"


class Violation(NamedTuple):
    path: str
    line: int
    message: str


def find_comment_violations(path: str, source: str) -> list[Violation]:
    violations: list[Violation] = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type != tokenize.COMMENT:
            continue
        line = token.start[0]
        if line == 1 and token.string.startswith("#!"):
            continue
        violations.append(Violation(path, line, COMMENT_MESSAGE))
    return violations


def find_docstring_violations(path: str, source: str) -> list[Violation]:
    violations: list[Violation] = []
    for node in ast.walk(ast.parse(source, filename=path)):
        if not isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            continue
        if ast.get_docstring(node, clean=False) is not None:
            violations.append(Violation(path, node.body[0].lineno, DOCSTRING_MESSAGE))
    return sorted(violations)


def list_python_files(root: Path) -> list[str]:
    output = subprocess.run(
        [
            "git",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            "*.py",
        ],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [path for path in output.split("\0") if path]


def check_repository(root: Path) -> list[Violation]:
    violations: list[Violation] = []
    for path in list_python_files(root):
        file = root / path
        if not file.exists():
            continue
        source = file.read_text(encoding="utf-8")
        violations.extend(find_comment_violations(path, source))
        violations.extend(find_docstring_violations(path, source))
    return violations


def test_flags_a_comment_token() -> None:
    source = "x = 1\ny = 2  # explain y\n"
    assert find_comment_violations("a.py", source) == [
        Violation("a.py", 2, "comment is not allowed")
    ]


def test_flags_a_module_or_function_docstring() -> None:
    source = '"""Module doc."""\n\n\ndef f():\n    """Function doc."""\n    return 1\n'
    assert find_docstring_violations("b.py", source) == [
        Violation("b.py", 1, "docstring is not allowed"),
        Violation("b.py", 5, "docstring is not allowed"),
    ]


def test_flags_a_class_and_async_function_docstring() -> None:
    source = (
        'class C:\n    """Class doc."""\n\n    async def g(self):\n        """Doc."""\n'
    )
    assert find_docstring_violations("c.py", source) == [
        Violation("c.py", 2, "docstring is not allowed"),
        Violation("c.py", 5, "docstring is not allowed"),
    ]


def test_ignores_a_hash_inside_a_string() -> None:
    source = 'url = "https://example.com/#anchor"\ntag = f"#{1}"\ntext = """\n# not a comment\n"""\n'
    assert find_comment_violations("d.py", source) == []
    assert find_docstring_violations("d.py", source) == []


def test_allows_a_shebang_on_line_1() -> None:
    source = "#!/usr/bin/env python3\nprint(1)\n"
    assert find_comment_violations("e.py", source) == []


def test_reports_path_and_line_for_files_in_a_repository() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "pkg").mkdir()
        (root / "pkg" / "bad.py").write_text("x = 1\n# nope\n", encoding="utf-8")
        (root / "good.py").write_text('s = "# fine"\n', encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        assert check_repository(root) == [Violation("pkg/bad.py", 2, COMMENT_MESSAGE)]


SELF_TESTS: list[Callable[[], None]] = [
    test_flags_a_comment_token,
    test_flags_a_module_or_function_docstring,
    test_flags_a_class_and_async_function_docstring,
    test_ignores_a_hash_inside_a_string,
    test_allows_a_shebang_on_line_1,
    test_reports_path_and_line_for_files_in_a_repository,
]


def run_self_tests() -> int:
    failures = 0
    for case in SELF_TESTS:
        name = case.__name__.removeprefix("test_").replace("_", " ")
        try:
            case()
        except AssertionError:
            failures += 1
            print(f"not ok - {name}")
        else:
            print(f"ok - {name}")
    print(f"# pass {len(SELF_TESTS) - failures}")
    print(f"# fail {failures}")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if argv[1:] == ["--self-test"]:
        return run_self_tests()
    violations = check_repository(Path.cwd())
    for violation in violations:
        print(f"{violation.path}:{violation.line}: {violation.message}")
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
