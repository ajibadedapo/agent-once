from __future__ import annotations

import pytest

pytest_plugins = ("pytester",)


def test_once_guard_fixture_dedupes_a_decorated_function(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(
        """
        from agent_once import ManualClock

        def test_dedupes(once_guard, once_clock):
            calls = []

            @once_guard.tool(intent_key="order-1")
            def place_order(item):
                calls.append(item)
                return {"order": len(calls)}

            assert place_order("Blue mug") == {"order": 1}
            once_clock.advance(1_234)
            assert place_order("Blue mug") == {"order": 1}
            assert calls == ["Blue mug"]
            assert isinstance(once_clock, ManualClock)
            assert once_clock.now_ms() == 1_761_912_345_678 + 1_234

        def test_each_test_gets_a_fresh_ledger(once_guard):
            calls = []

            @once_guard.tool(intent_key="order-1")
            def place_order(item):
                calls.append(item)
                return {"order": len(calls)}

            place_order("Blue mug")
            assert calls == ["Blue mug"]
        """
    )
    result = pytester.runpytest("-p", "no:cacheprovider")
    result.assert_outcomes(passed=2)


def test_agent_once_chaos_targets_fixture_records_a_duplicate_from_an_unguarded_double_call(
    pytester: pytest.Pytester,
) -> None:
    pytester.makepyfile(
        """
        import json
        import urllib.error
        import urllib.request

        import pytest

        ORDER = {"item": "Blue mug", "qty": "1"}

        def place_order(url):
            request = urllib.request.Request(
                url + "/api/checkout",
                data=json.dumps(ORDER).encode(),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                return response.status

        @pytest.mark.chaos
        def test_single_call_is_clean(agent_once_chaos_targets):
            assert agent_once_chaos_targets.url.startswith("http://127.0.0.1:")
            assert place_order(agent_once_chaos_targets.url) == 201
            agent_once_chaos_targets.assert_no_duplicates()
            agent_once_chaos_targets.assert_exactly_one("checkout")

        @pytest.mark.chaos
        def test_unguarded_double_call(agent_once_chaos_targets):
            place_order(agent_once_chaos_targets.url)
            place_order(agent_once_chaos_targets.url)
            assert [effect["id"] for effect in agent_once_chaos_targets.truth()["checkout"]] == [
                "ORD-1",
                "ORD-2",
            ]
            agent_once_chaos_targets.assert_no_duplicates()

        @pytest.mark.chaos
        def test_state_is_reset_between_tests(agent_once_chaos_targets):
            assert agent_once_chaos_targets.truth()["checkout"] == []

        def post_ticket(url):
            request = urllib.request.Request(
                url + "/api/ticket",
                data=json.dumps({"title": "Printer jam", "body": "Jammed."}).encode(),
                headers={"content-type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request) as response:
                    return response.status
            except urllib.error.HTTPError as error:
                error.close()
                return error.code

        @pytest.mark.chaos
        def test_faults_apply(agent_once_chaos_targets):
            agent_once_chaos_targets.set_faults(
                [{"target": "ticket", "nth": 1, "kind": "stale_element", "holdMs": 0}]
            )
            assert post_ticket(agent_once_chaos_targets.url) == 409
            with pytest.raises(ValueError, match="unknown target"):
                agent_once_chaos_targets.set_faults(
                    [{"target": "nowhere", "nth": 1, "kind": "none"}]
                )
            with pytest.raises(AssertionError, match="exactly one ticket effect, found 0$"):
                agent_once_chaos_targets.assert_exactly_one("ticket")
            with pytest.raises(ValueError, match="unknown target nowhere"):
                agent_once_chaos_targets.assert_exactly_one("nowhere")

        @pytest.mark.chaos
        def test_reset_clears_faults(agent_once_chaos_targets):
            assert post_ticket(agent_once_chaos_targets.url) == 201
            agent_once_chaos_targets.assert_exactly_one("ticket")
        """
    )
    result = pytester.runpytest("-p", "no:cacheprovider", "--strict-markers")
    result.assert_outcomes(passed=4, failed=1)
    result.stdout.fnmatch_lines(
        [
            "E*AssertionError: checkout has 2 effects with the same fields "
            '{"item":"Blue mug","qty":"1"}: ORD-1, ORD-2',
            "FAILED *::test_unguarded_double_call*",
        ]
    )
    result.stdout.no_fnmatch_line("*chaos_client.py*")
