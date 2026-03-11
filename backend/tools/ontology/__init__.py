"""Ontology tools for schema-aware reasoning."""

from .ontology_tools import ontology_query, ontology_extract
from .external_import import search_lov, import_owl, import_schema_org, import_from_wikidata
from .merge_imported import merge_imported_ontology_tool, list_imported_candidates, merge_imported_into_kg
from .unified_ontology_import import ontology_import as ontology_import_tool

__all__ = [
    "ontology_query",
    "ontology_extract",
    "ontology_import_tool",
    "search_lov",
    "import_owl",
    "import_schema_org",
    "import_from_wikidata",
    "merge_imported_ontology_tool",
    "list_imported_candidates",
    "merge_imported_into_kg",
]
