"""Wordcloud quality validation - checks for stop words and rendering issues."""

import csv
import os
from typing import List, Tuple

# Same stopword lists as in agent prompt
ENGLISH_STOPWORDS = {
    # Articles, determiners
    'a', 'an', 'the', 'this', 'that', 'these', 'those',
    # Pronouns
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
    'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves', 'themselves',
    # Prepositions
    'in', 'on', 'at', 'to', 'for', 'of', 'from', 'by', 'with', 'about', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'under', 'over', 'against',
    # Conjunctions
    'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'while', 'if', 'unless',
    'until', 'when', 'where', 'whether', 'than', 'as', 'since',
    # Verbs (common)
    'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having',
    'do', 'does', 'did', 'doing', 'will', 'would', 'should', 'could', 'may', 'might', 'must',
    'can', 'shall',
    # Adverbs
    'not', 'no', 'yes', 'very', 'too', 'also', 'just', 'only', 'even', 'now', 'then',
    'here', 'there', 'how', 'why', 'what', 'who', 'which', 'whom', 'whose',
    # Other common words
    'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'own', 'same', 'out', 'up', 'down', 'off', 'again', 'further', 'once'
}

ARABIC_STOPWORDS = {
    # Prepositions and particles
    'في', 'من', 'إلى', 'على', 'عن', 'الى', 'الي', 'مع', 'ضد', 'حول', 'خلال',
    'عند', 'لدى', 'منذ', 'حتى', 'ب', 'ل', 'ك',
    # Conjunctions
    'و', 'أو', 'لكن', 'لكن', 'بل', 'إذا', 'لو', 'ف',
    # Pronouns
    'هو', 'هي', 'هم', 'هن', 'أنت', 'أنتم', 'أنا', 'نحن', 'أنتن',
    'ه', 'ها', 'هما', 'كم', 'كما', 'هذا', 'هذه', 'ذلك', 'تلك',
    # Verbs (common auxiliaries)
    'كان', 'يكون', 'تكون', 'كانت', 'ليس', 'ليست', 'كن',
    # Question words
    'ما', 'ماذا', 'من', 'متى', 'أين', 'كيف', 'لماذا', 'هل', 'أي',
    # Determiners
    'ال', 'كل', 'بعض', 'جميع', 'أحد', 'إحدى',
    # Time/sequence
    'قبل', 'بعد', 'ثم', 'الآن', 'أمس', 'اليوم', 'غدا',
    # Common words
    'أن', 'ان', 'إن', 'لا', 'لم', 'لن', 'قد', 'التي', 'الذي', 'اللذان',
    'اللتان', 'الذين', 'اللاتي', 'اللواتي', 'عن', 'عند', 'غير', 'بعد',
    'بين', 'ذات', 'صار', 'أصبح', 'أضحى', 'ظل', 'أمسى', 'بات', 'ما زال'
}


def validate_wordcloud_quality(csv_file_path: str, language: str) -> Tuple[bool, List[str], int]:
    """
    Validate wordcloud CSV for stop word contamination.

    Args:
        csv_file_path: Path to the CSV file with word frequencies
        language: 'en' for English, 'ar' for Arabic

    Returns:
        (is_valid, stopwords_found, score_deduction)
    """
    if not os.path.exists(csv_file_path):
        return False, [f"CSV file not found: {csv_file_path}"], 50

    stopwords_set = ENGLISH_STOPWORDS if language == 'en' else ARABIC_STOPWORDS
    stopwords_found = []

    try:
        with open(csv_file_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                word = row.get('token', row.get('word', '')).strip()
                if word.lower() in stopwords_set or word in stopwords_set:
                    count = row.get('count', row.get('frequency', '?'))
                    stopwords_found.append(f"{word} ({count} occurrences)")
    except Exception as e:
        return False, [f"Error reading CSV: {str(e)}"], 30

    # Score deduction: -5 points per stop word found (max -50)
    deduction = min(len(stopwords_found) * 5, 50)
    is_valid = len(stopwords_found) == 0

    return is_valid, stopwords_found, deduction


def validate_arabic_rendering(image_path: str) -> Tuple[bool, str]:
    """
    Check if Arabic wordcloud image has proper text rendering (not boxes).

    This is a heuristic check - looks for:
    - Image variance (boxes = low variance, text = high variance)
    - Proper resolution

    Args:
        image_path: Path to the wordcloud PNG image

    Returns:
        (is_valid, message)
    """
    if not os.path.exists(image_path):
        return False, f"Image file not found: {image_path}"

    # Simplified check - in production, use OCR or visual analysis
    # For now, just verify file size is reasonable
    try:
        file_size = os.path.getsize(image_path)

        if file_size < 50000:  # Less than 50KB suggests rendering failure
            return False, f"Image suspiciously small ({file_size} bytes) - possible rendering failure"

        return True, "OK"
    except Exception as e:
        return False, f"Error checking image: {str(e)}"


def get_wordcloud_validation_report(output_dir: str) -> dict:
    """
    Generate a comprehensive validation report for all wordcloud files in the output directory.

    Args:
        output_dir: Directory containing wordcloud files

    Returns:
        Dictionary with validation results for each file
    """
    report = {
        'aje_english': {'valid': True, 'issues': [], 'deduction': 0},
        'aja_arabic': {'valid': True, 'issues': [], 'deduction': 0},
        'total_deduction': 0
    }

    # Check English (AJE) wordcloud
    aje_csv = os.path.join(output_dir, 'aje_freq.csv')
    if os.path.exists(aje_csv):
        is_valid, stops_found, deduction = validate_wordcloud_quality(aje_csv, 'en')
        if not is_valid:
            report['aje_english']['valid'] = False
            report['aje_english']['issues'] = stops_found[:10]  # First 10
            report['aje_english']['deduction'] = deduction
            report['total_deduction'] += deduction

    # Check Arabic (AJA) wordcloud CSV
    aja_csv = os.path.join(output_dir, 'aja_freq.csv')
    if os.path.exists(aja_csv):
        is_valid, stops_found, deduction = validate_wordcloud_quality(aja_csv, 'ar')
        if not is_valid:
            report['aja_arabic']['valid'] = False
            report['aja_arabic']['issues'] = stops_found[:10]  # First 10
            report['aja_arabic']['deduction'] = deduction
            report['total_deduction'] += deduction

    # Check Arabic rendering quality
    aja_img = os.path.join(output_dir, 'aja_wordcloud.png')
    if os.path.exists(aja_img):
        is_valid, msg = validate_arabic_rendering(aja_img)
        if not is_valid:
            report['aja_arabic']['valid'] = False
            report['aja_arabic']['issues'].append(f"Rendering: {msg}")
            report['aja_arabic']['deduction'] += 20
            report['total_deduction'] += 20

    return report
