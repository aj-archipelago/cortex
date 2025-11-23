#!/usr/bin/env python3
"""
Test script to explore Al Jazeera database schema and understand actual data structure.

This script connects to AJ databases and provides detailed schema information
to help the aj_sql_agent generate correct queries instead of making assumptions.
"""

import os
import json
import sys
from datetime import datetime
from sqlalchemy import create_engine, text, MetaData, Table
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    # Try to load from current directory or parent directory
    env_loaded = load_dotenv() or load_dotenv(dotenv_path='../.env')
    if env_loaded:
        print("✅ Loaded environment variables from .env file")
    else:
        print("⚠️ Could not load .env file, using existing environment variables")
except ImportError:
    print("⚠️ python-dotenv not available, using existing environment variables")


def get_aj_sql_engine() -> Engine:
    """Get SQLAlchemy engine for AJ databases."""
    url = os.environ.get("AJ_MYSQL_URL")
    if not url:
        print("❌ ERROR: AJ_MYSQL_URL environment variable is not set.")
        sys.exit(1)

    try:
        engine = create_engine(url, connect_args={"ssl": {"ssl": True}})
        return engine
    except SQLAlchemyError as exc:
        print(f"❌ ERROR: Failed to initialize MySQL engine: {exc}")
        sys.exit(1)


def test_database_connection(database: str) -> bool:
    """Test connection to specific database."""
    print(f"🔍 Testing connection to database: {database}")

    try:
        engine = get_aj_sql_engine()
        with engine.connect() as connection:
            # Try to use the database
            connection.execute(text(f"USE `{database}`"))
            print(f"✅ Successfully connected to {database}")
            return True
    except SQLAlchemyError as exc:
        print(f"❌ Failed to connect to {database}: {exc}")
        return False


def get_all_tables(database: str) -> list:
    """Get all tables in the database."""
    print(f"📋 Getting all tables in {database}...")

    try:
        engine = get_aj_sql_engine()
        with engine.connect() as connection:
            connection.execute(text(f"USE `{database}`"))

            # Get all tables
            result = connection.execute(text("SHOW TABLES"))
            tables = [row[0] for row in result.fetchall()]

            print(f"📊 Found {len(tables)} tables: {', '.join(tables[:10])}{'...' if len(tables) > 10 else ''}")
            return tables
    except SQLAlchemyError as exc:
        print(f"❌ Error getting tables: {exc}")
        return []


def describe_table(database: str, table_name: str) -> dict:
    """Describe a specific table and return its structure."""
    print(f"🔍 Describing table: {database}.{table_name}")

    try:
        engine = get_aj_sql_engine()
        with engine.connect() as connection:
            connection.execute(text(f"USE `{database}`"))

            # Get table structure
            result = connection.execute(text(f"DESCRIBE `{table_name}`"))
            columns = []
            for row in result.fetchall():
                columns.append({
                    'field': row[0],
                    'type': row[1],
                    'null': row[2],
                    'key': row[3],
                    'default': row[4],
                    'extra': row[5]
                })

            print(f"  📝 {len(columns)} columns found")
            return {
                'table': table_name,
                'columns': columns,
                'column_count': len(columns)
            }
    except SQLAlchemyError as exc:
        print(f"❌ Error describing table {table_name}: {exc}")
        return {}


def sample_table_data(database: str, table_name: str, limit: int = 5) -> dict:
    """Sample data from a table to understand its structure."""
    print(f"📊 Sampling {limit} rows from {database}.{table_name}")

    try:
        engine = get_aj_sql_engine()
        with engine.connect() as connection:
            connection.execute(text(f"USE `{database}`"))

            # Get row count
            count_result = connection.execute(text(f"SELECT COUNT(*) FROM `{table_name}`"))
            total_rows = count_result.fetchone()[0]

            # Sample data
            result = connection.execute(text(f"SELECT * FROM `{table_name}` LIMIT {limit}"))
            columns = list(result.keys())
            rows = [dict(row) for row in result.mappings()]

            print(f"  📈 Total rows: {total_rows}, sampled {len(rows)} rows")

            # Analyze data types in sample
            data_types = {}
            if rows:
                for col in columns:
                    values = [row.get(col) for row in rows if row.get(col) is not None]
                    if values:
                        types = set(type(v).__name__ for v in values)
                        data_types[col] = list(types)

            return {
                'table': table_name,
                'total_rows': total_rows,
                'sampled_rows': len(rows),
                'columns': columns,
                'sample_data': rows,
                'inferred_types': data_types
            }
    except SQLAlchemyError as exc:
        print(f"❌ Error sampling table {table_name}: {exc}")
        return {}


def compare_database_schemas(databases: list) -> dict:
    """Compare table structures across all AJ databases."""
    print(f"🔍 COMPARING SCHEMAS ACROSS {len(databases)} DATABASES")

    schema_comparison = {}

    # Get tables from each database
    for db in databases:
        if not test_database_connection(db):
            continue

        tables = get_all_tables(db)
        if tables:
            schema_comparison[db] = {
                'table_count': len(tables),
                'tables': sorted(tables)
            }

    # Compare table sets
    if schema_comparison:
        first_db = list(schema_comparison.keys())[0]
        reference_tables = set(schema_comparison[first_db]['tables'])

        print(f"\n📊 TABLE COMPARISON:")
        print(f"Reference DB ({first_db}): {len(reference_tables)} tables")

        for db, info in schema_comparison.items():
            if db == first_db:
                continue

            db_tables = set(info['tables'])
            common = reference_tables.intersection(db_tables)
            only_in_ref = reference_tables - db_tables
            only_in_db = db_tables - reference_tables

            print(f"{db}: {len(db_tables)} tables")
            print(f"  ✅ Common: {len(common)} tables")
            if only_in_ref:
                print(f"  ⚠️ Only in {first_db}: {list(only_in_ref)[:3]}{'...' if len(only_in_ref) > 3 else ''}")
            if only_in_db:
                print(f"  ⚠️ Only in {db}: {list(only_in_db)[:3]}{'...' if len(only_in_db) > 3 else ''}")

    return schema_comparison


def analyze_posts_table(database: str) -> dict:
    """Analyze the wp_posts table to understand what data actually exists."""
    print(f"🔬 ANALYZING wp_posts IN {database}")

    try:
        engine = get_aj_sql_engine()
        with engine.connect() as connection:
            connection.execute(text(f"USE `{database}`"))

            # Get total post count
            result = connection.execute(text("SELECT COUNT(*) FROM wp_posts"))
            total_posts = result.fetchone()[0]
            print(f"  📊 Total posts: {total_posts:,}")

            # Check post status distribution
            result = connection.execute(text("SELECT post_status, COUNT(*) as count FROM wp_posts GROUP BY post_status ORDER BY count DESC LIMIT 10"))
            statuses = result.fetchall()
            print(f"  📋 Post statuses: {', '.join([f'{s[0]}({s[1]:,})' for s in statuses])}")

            # Check post type distribution
            result = connection.execute(text("SELECT post_type, COUNT(*) as count FROM wp_posts GROUP BY post_type ORDER BY count DESC LIMIT 10"))
            types = result.fetchall()
            print(f"  📋 Post types: {', '.join([f'{t[0]}({t[1]:,})' for t in types])}")

            # Check date range
            result = connection.execute(text("SELECT MIN(post_date_gmt) as min_date, MAX(post_date_gmt) as max_date FROM wp_posts WHERE post_date_gmt IS NOT NULL"))
            date_row = result.fetchone()
            if date_row and date_row[0] and date_row[1]:
                print(f"  📅 Date range: {date_row[0]} to {date_row[1]}")

            # Check recent posts (last 30 days)
            result = connection.execute(text("SELECT COUNT(*) FROM wp_posts WHERE post_date_gmt >= DATE_SUB(UTC_DATE(), INTERVAL 30 DAY)"))
            recent_count = result.fetchone()[0]
            print(f"  🕐 Posts in last 30 days: {recent_count:,}")

            # Check posts with specific conditions (what aj_sql_agent queries)
            result = connection.execute(text("""
                SELECT COUNT(*) FROM wp_posts
                WHERE post_status = 'publish'
                AND post_type = 'article'
                AND post_date_gmt >= DATE_SUB(UTC_DATE(), INTERVAL 29 DAY)
            """))
            matching_count = result.fetchone()[0]
            print(f"  🎯 Posts matching aj_sql_agent query: {matching_count:,}")

            # Sample some actual posts
            result = connection.execute(text("""
                SELECT post_date_gmt, post_title, post_status, post_type
                FROM wp_posts
                WHERE post_date_gmt IS NOT NULL
                ORDER BY post_date_gmt DESC
                LIMIT 3
            """))
            recent_posts = result.fetchall()

            print(f"  📝 Most recent posts:")
            for post in recent_posts:
                title = str(post[1])[:50] + "..." if len(str(post[1])) > 50 else str(post[1])
                print(f"    📄 {post[0]} | {title} | {post[2]} | {post[3]}")

            return {
                'total_posts': total_posts,
                'statuses': statuses,
                'types': types,
                'date_range': date_row,
                'recent_count': recent_count,
                'matching_count': matching_count,
                'sample_posts': recent_posts
            }

    except SQLAlchemyError as exc:
        print(f"❌ Error analyzing posts table: {exc}")
        return {}


def compare_table_columns(database: str, table_name: str, databases: list) -> dict:
    """Compare a specific table's columns across all databases."""
    print(f"🔍 COMPARING TABLE '{table_name}' ACROSS DATABASES")

    table_comparison = {}

    for db in databases:
        table_info = describe_table(db, table_name)
        if table_info and table_info.get('columns'):
            columns = table_info['columns']
            column_names = [col['field'] for col in columns]
            table_comparison[db] = {
                'column_count': len(columns),
                'columns': column_names,
                'structure': columns
            }
            print(f"  {db}: {len(columns)} columns - {', '.join(column_names[:5])}{'...' if len(column_names) > 5 else ''}")

    # Compare columns
    if len(table_comparison) > 1:
        first_db = list(table_comparison.keys())[0]
        reference_cols = set(table_comparison[first_db]['columns'])

        print(f"\n📊 COLUMN COMPARISON for {table_name}:")
        for db, info in table_comparison.items():
            if db == first_db:
                continue

            db_cols = set(info['columns'])
            common = reference_cols.intersection(db_cols)
            only_in_ref = reference_cols - db_cols
            only_in_db = db_cols - reference_cols

            print(f"  {db} vs {first_db}:")
            print(f"    ✅ Common: {len(common)} columns")
            if only_in_ref:
                print(f"    ⚠️ Only in {first_db}: {list(only_in_ref)}")
            if only_in_db:
                print(f"    ⚠️ Only in {db}: {list(only_in_db)}")

    return table_comparison


def check_post_distributions(database: str, table_name: str) -> dict:
    """Check distributions of post statuses and types."""
    print(f"📈 Checking post distributions in {database}.{table_name}")

    try:
        engine = get_aj_sql_engine()
        with engine.connect() as connection:
            connection.execute(text(f"USE `{database}`"))

            distributions = {}

            # Check post_status distribution
            try:
                result = connection.execute(text(f"SELECT post_status, COUNT(*) as count FROM `{table_name}` GROUP BY post_status ORDER BY count DESC LIMIT 10"))
                distributions['post_status'] = [{'status': row[0], 'count': row[1]} for row in result.fetchall()]
                print(f"  📊 Post statuses: {distributions['post_status']}")
            except:
                print("  ⚠️ Could not check post_status distribution")

            # Check post_type distribution
            try:
                result = connection.execute(text(f"SELECT post_type, COUNT(*) as count FROM `{table_name}` GROUP BY post_type ORDER BY count DESC LIMIT 10"))
                distributions['post_type'] = [{'type': row[0], 'count': row[1]} for row in result.fetchall()]
                print(f"  📊 Post types: {distributions['post_type']}")
            except:
                print("  ⚠️ Could not check post_type distribution")

            # Check date range
            try:
                result = connection.execute(text(f"SELECT MIN(post_date_gmt) as min_date, MAX(post_date_gmt) as max_date, COUNT(*) as total FROM `{table_name}` WHERE post_date_gmt IS NOT NULL"))
                row = result.fetchone()
                if row:
                    distributions['date_range'] = {
                        'min_date': str(row[0]),
                        'max_date': str(row[1]),
                        'total_posts': row[2]
                    }
                    print(f"  📅 Date range: {distributions['date_range']['min_date']} to {distributions['date_range']['max_date']} ({distributions['date_range']['total_posts']} posts)")
            except:
                print("  ⚠️ Could not check date range")

            return distributions

    except SQLAlchemyError as exc:
        print(f"❌ Error checking distributions: {exc}")
        return {}


def main():
    """Main function to comprehensively compare AJ database schemas."""
    print("🗄️ Al Jazeera Database Schema Comparison Tool")
    print("=" * 60)

    # All AJ databases to check
    databases = [
        'ucms_aja',      # Arabic (reference)
        'ucms_aje',      # English
        'ucms_ajb',      # Balkans
        'ucms_ajd',      # Documentary
        'ucms_aj360',    # AJ360
        'ucms_ajm',      # Mubasher
        'ucms_chinese',  # Chinese
        'ucms_sanad'     # Sanad
    ]

    print(f"🔍 CHECKING {len(databases)} AJ DATABASES")
    print("-" * 40)

    # Phase 1: Get schema for all databases
    schema_data = {}
    working_databases = []

    for db in databases:
        print(f"\n🔍 Checking {db}...")
        if test_database_connection(db):
            tables = get_all_tables(db)
            if tables:
                # Get detailed column info for all tables
                table_details = {}
                for table in tables:
                    table_info = describe_table(db, table)
                    if table_info:
                        columns = [col['field'] for col in table_info.get('columns', [])]
                        table_details[table] = sorted(columns)

                schema_data[db] = {
                    'tables': sorted(tables),
                    'table_details': table_details
                }
                working_databases.append(db)
                print(f"  ✅ {db}: {len(tables)} tables")
            else:
                print(f"  ❌ {db}: No tables found")
        else:
            print(f"  ❌ {db}: Connection failed")

    if not working_databases:
        print("❌ No databases could be accessed")
        return

    # Use AJA as reference
    reference_db = 'ucms_aja'
    if reference_db not in working_databases:
        print(f"❌ Reference database {reference_db} not available")
        return

    reference_data = schema_data[reference_db]

    # Phase 2: Print reference schema
    print(f"\n{'='*60}")
    print(f"📊 REFERENCE DATABASE: {reference_db}")
    print(f"{'='*60}")

    print(f"\n📋 TABLES ({len(reference_data['tables'])}):")
    table_list = []
    for table in reference_data['tables']:
        table_list.append(table)
    print(f"  {', '.join(table_list)}")

    print(f"\n📝 TABLE COLUMNS:")
    for table in sorted(reference_data['tables']):
        columns = reference_data['table_details'].get(table, [])
        print(f"  {table}({len(columns)}): {', '.join(columns)}")

    # Phase 3: Compare all other databases
    print(f"\n{'='*60}")
    print(f"🔍 SCHEMA DIFFERENCES (compared to {reference_db})")
    print(f"{'='*60}")

    differences_found = False

    for db in working_databases:
        if db == reference_db:
            continue

        print(f"\n🗄️ {db}:")
        db_data = schema_data[db]

        # Compare tables
        ref_tables = set(reference_data['tables'])
        db_tables = set(db_data['tables'])

        missing_tables = ref_tables - db_tables
        extra_tables = db_tables - ref_tables

        if missing_tables:
            print(f"  ❌ MISSING TABLES: {sorted(missing_tables)}")
            differences_found = True

        if extra_tables:
            print(f"  ➕ EXTRA TABLES: {sorted(extra_tables)}")
            differences_found = True

        # Compare columns for common tables
        common_tables = ref_tables.intersection(db_tables)
        column_differences = []

        for table in common_tables:
            ref_columns = set(reference_data['table_details'].get(table, []))
            db_columns = set(db_data['table_details'].get(table, []))

            missing_cols = ref_columns - db_columns
            extra_cols = db_columns - ref_columns

            if missing_cols or extra_cols:
                diff_info = f"{table}:"
                if missing_cols:
                    diff_info += f" missing {sorted(missing_cols)}"
                if extra_cols:
                    if missing_cols:
                        diff_info += ","
                    diff_info += f" extra {sorted(extra_cols)}"
                column_differences.append(diff_info)

        if column_differences:
            print(f"  🔧 COLUMN DIFFERENCES:")
            for diff in column_differences:
                print(f"    {diff}")
            differences_found = True

        if not missing_tables and not extra_tables and not column_differences:
            print(f"  ✅ IDENTICAL to {reference_db}")

    if not differences_found:
        print(f"\n🎉 ALL DATABASES HAVE IDENTICAL SCHEMA!")
    else:
        print(f"\n⚠️ SCHEMA DIFFERENCES FOUND - SEE DETAILS ABOVE")

    print(f"\n{'='*60}")
    print(f"📈 SUMMARY: {len(working_databases)} databases checked, {len(reference_data['tables'])} tables in reference")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
