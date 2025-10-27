#!/usr/bin/env python3
"""
Isolation test script for fetch_entity_images() function
Tests multi-tier entity image fetcher with various scenarios
"""

import asyncio
import json
import os
import sys
import tempfile
import shutil
from pathlib import Path

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tools.search_tools import fetch_entity_images


class TestRunner:
    """Runs isolation tests for fetch_entity_images"""

    def __init__(self):
        self.work_dir = tempfile.mkdtemp(prefix="entity_test_")
        self.results = []
        print(f"🔬 Test work directory: {self.work_dir}\n")

    def cleanup(self):
        """Clean up test directory"""
        if os.path.exists(self.work_dir):
            shutil.rmtree(self.work_dir)
            print(f"\n🧹 Cleaned up test directory")

    async def run_test(self, name: str, entities: list, entity_type: str, count_per_entity: int = 1, force_web_search: bool = False):
        """Run a single test case"""
        print("=" * 80)
        print(f"🧪 TEST: {name}")
        print("=" * 80)
        print(f"   Entities: {entities}")
        print(f"   Type: {entity_type}")
        print(f"   Count per entity: {count_per_entity}")
        print(f"   Force web search: {force_web_search}")
        print()

        try:
            result_json = await fetch_entity_images(
                entities=entities,
                entity_type=entity_type,
                count_per_entity=count_per_entity,
                work_dir=self.work_dir,
                force_web_search=force_web_search
            )

            result = json.loads(result_json)

            # Print summary
            print("📊 RESULT:")
            print(f"   Success: {result.get('success', False)}")
            print(f"   Total images: {result.get('stats', {}).get('total_images', 0)}")
            print(f"   API success: {result.get('stats', {}).get('api_success', 0)}")
            print(f"   API failed: {result.get('stats', {}).get('api_failed', 0)}")
            print(f"   Web search used: {result.get('stats', {}).get('web_search_used', 0)}")

            # Show per-entity breakdown
            if 'results' in result:
                print("\n   Per-entity results:")
                for entity_data in result['results']:
                    entity_name = entity_data.get('entity', 'unknown')
                    img_count = len(entity_data.get('images', []))
                    method = entity_data.get('method', 'unknown')
                    api_used = entity_data.get('api_used', 'N/A')
                    print(f"      {entity_name}: {img_count} images via {method} ({api_used})")

            # Show sample image paths
            if 'results' in result:
                print("\n   Sample images:")
                for entity_data in result['results']:
                    entity_name = entity_data.get('entity', 'unknown')
                    images = entity_data.get('images', [])
                    if images:
                        sample = images[0]
                        filename = os.path.basename(sample.get('local_path', 'N/A'))
                        print(f"      {entity_name}: {filename}")

            if not result.get('success'):
                print(f"\n   ⚠️  Error: {result.get('error', 'Unknown error')}")

            self.results.append({
                'name': name,
                'success': result.get('success', False),
                'result': result
            })

            print("\n✅ TEST PASSED\n")
            return result

        except Exception as e:
            print(f"\n❌ TEST FAILED: {str(e)}\n")
            import traceback
            traceback.print_exc()
            self.results.append({
                'name': name,
                'success': False,
                'error': str(e)
            })
            return None

    async def run_all_tests(self):
        """Run all test scenarios"""
        print("\n" + "=" * 80)
        print("🚀 STARTING ISOLATION TESTS FOR fetch_entity_images()")
        print("=" * 80)
        print()

        # TEST 1: Pokemon entities (primary use case - should use PokeAPI)
        await self.run_test(
            name="Pokemon - PokeAPI Integration",
            entities=["pikachu", "charizard", "mewtwo"],
            entity_type="pokemon",
            count_per_entity=1
        )

        await asyncio.sleep(2)

        # TEST 2: Single Pokemon with multiple images
        await self.run_test(
            name="Pokemon - Multiple Images per Entity",
            entities=["gengar"],
            entity_type="pokemon",
            count_per_entity=3
        )

        await asyncio.sleep(2)

        # TEST 3: Country entities (should use REST Countries API)
        await self.run_test(
            name="Countries - REST Countries API",
            entities=["france", "japan", "brazil"],
            entity_type="country",
            count_per_entity=1
        )

        await asyncio.sleep(2)

        # TEST 4: Invalid Pokemon name (should fallback to web search)
        await self.run_test(
            name="Pokemon - Invalid Name Fallback",
            entities=["invalidpokemonxyz123"],
            entity_type="pokemon",
            count_per_entity=1
        )

        await asyncio.sleep(2)

        # TEST 5: Unknown entity type (should fallback to web search)
        await self.run_test(
            name="Unknown Entity Type - Web Search Fallback",
            entities=["tesla model 3"],
            entity_type="car",
            count_per_entity=2
        )

        await asyncio.sleep(2)

        # TEST 6: Force web search even for known entity type
        await self.run_test(
            name="Pokemon - Force Web Search Override",
            entities=["dragonite"],
            entity_type="pokemon",
            count_per_entity=1,
            force_web_search=True
        )

        await asyncio.sleep(2)

        # TEST 7: Mixed valid/invalid Pokemon (test fallback handling)
        await self.run_test(
            name="Pokemon - Mixed Valid/Invalid Entities",
            entities=["bulbasaur", "notarealpokemon999", "squirtle"],
            entity_type="pokemon",
            count_per_entity=1
        )

        await asyncio.sleep(2)

        # TEST 8: Empty entity list (edge case)
        await self.run_test(
            name="Edge Case - Empty Entity List",
            entities=[],
            entity_type="pokemon",
            count_per_entity=1
        )

        await asyncio.sleep(2)

        # TEST 9: Pokemon with numbers (Gen 1 powerful pokemon)
        await self.run_test(
            name="Pokemon - Gen 1 Powerful Pokemon",
            entities=["mewtwo", "dragonite", "alakazam", "gengar", "zapdos"],
            entity_type="pokemon",
            count_per_entity=1
        )

        # Print summary
        self.print_summary()

    def print_summary(self):
        """Print test summary"""
        print("\n" + "=" * 80)
        print("📊 TEST SUMMARY")
        print("=" * 80)

        passed = sum(1 for r in self.results if r.get('success'))
        total = len(self.results)

        print(f"\nTotal Tests: {total}")
        print(f"Passed: {passed}")
        print(f"Failed: {total - passed}")
        print(f"Success Rate: {(passed/total*100) if total > 0 else 0:.1f}%")

        print("\n📝 Individual Results:")
        for i, result in enumerate(self.results, 1):
            status = "✅ PASS" if result.get('success') else "❌ FAIL"
            print(f"   {i}. {status} - {result['name']}")

            if result.get('success') and 'result' in result:
                stats = result['result'].get('stats', {})
                total_images = stats.get('total_images', 0)
                api_success = stats.get('api_success', 0)
                web_search = stats.get('web_search_used', 0)

                methods = []
                if api_success > 0:
                    methods.append(f"{api_success} via API")
                if web_search > 0:
                    methods.append(f"{web_search} via web search")

                method_str = ", ".join(methods) if methods else "no images"
                print(f"      → {total_images} total images ({method_str})")

        print("\n" + "=" * 80)

        # Check for specific success criteria
        print("\n🎯 SUCCESS CRITERIA CHECK:")

        criteria = [
            ("Pokemon API integration works", any(
                r.get('success') and 'Pokemon - PokeAPI' in r['name']
                and r.get('result', {}).get('stats', {}).get('api_success', 0) > 0
                for r in self.results
            )),
            ("Country API integration works", any(
                r.get('success') and 'Countries - REST' in r['name']
                and r.get('result', {}).get('stats', {}).get('api_success', 0) > 0
                for r in self.results
            )),
            ("Web search fallback works for invalid entities", any(
                r.get('success') and 'Invalid Name Fallback' in r['name']
                and r.get('result', {}).get('stats', {}).get('web_search_used', 0) > 0
                for r in self.results
            )),
            ("Web search fallback works for unknown types", any(
                r.get('success') and 'Unknown Entity Type' in r['name']
                and r.get('result', {}).get('stats', {}).get('web_search_used', 0) > 0
                for r in self.results
            )),
            ("Force web search override works", any(
                r.get('success') and 'Force Web Search' in r['name']
                and r.get('result', {}).get('stats', {}).get('web_search_used', 0) > 0
                for r in self.results
            )),
            ("Multiple images per entity works", any(
                r.get('success') and 'Multiple Images' in r['name']
                and r.get('result', {}).get('stats', {}).get('total_images', 0) >= 3
                for r in self.results
            )),
        ]

        for criterion, passed in criteria:
            status = "✅ PASS" if passed else "❌ FAIL"
            print(f"   {status} - {criterion}")

        all_criteria_passed = all(passed for _, passed in criteria)

        print("\n" + "=" * 80)
        if all_criteria_passed:
            print("🎉 ALL CRITERIA PASSED - Tool is ready for integration!")
        else:
            print("⚠️  Some criteria failed - review results above")
        print("=" * 80)


async def main():
    """Main test runner"""
    runner = TestRunner()

    try:
        await runner.run_all_tests()
    finally:
        runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
