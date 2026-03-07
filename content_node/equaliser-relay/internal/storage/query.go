package storage

import (
	"fmt"
	"strings"

	"equaliser-relay/internal/nostr"
)

// BuildEventQuery builds a SELECT query for raw_events matching the given filters.
// Multiple filters are ORed together (NIP-01: events matching any filter are returned).
// Returns the SQL query string and parameter values.
func BuildEventQuery(filters []nostr.Filter, forCount bool) (string, []interface{}) {
	if len(filters) == 0 {
		if forCount {
			return "SELECT COUNT(*) FROM raw_events WHERE FALSE", nil
		}
		return "SELECT raw FROM raw_events WHERE FALSE", nil
	}

	var filterClauses []string
	var allArgs []interface{}
	argOffset := 1

	// Track the minimum limit across all filters
	minLimit := 500 // default
	hasLimit := false

	for _, f := range filters {
		clause, args, nextOffset := buildSingleFilterClause(f, argOffset)
		if clause != "" {
			filterClauses = append(filterClauses, "("+clause+")")
		} else {
			// Empty filter matches everything
			filterClauses = append(filterClauses, "(TRUE)")
		}
		allArgs = append(allArgs, args...)
		argOffset = nextOffset

		if f.Limit != nil {
			if !hasLimit || *f.Limit < minLimit {
				minLimit = *f.Limit
				hasLimit = true
			}
		}
	}

	whereClause := strings.Join(filterClauses, " OR ")

	if forCount {
		query := fmt.Sprintf("SELECT COUNT(*) FROM raw_events re WHERE %s", whereClause)
		return query, allArgs
	}

	query := fmt.Sprintf("SELECT re.raw FROM raw_events re WHERE %s ORDER BY re.created_at DESC LIMIT %d",
		whereClause, minLimit)

	return query, allArgs
}

// buildSingleFilterClause builds the WHERE conditions for a single filter.
func buildSingleFilterClause(f nostr.Filter, argOffset int) (string, []interface{}, int) {
	var conditions []string
	var args []interface{}
	idx := argOffset

	// IDs filter
	if len(f.IDs) > 0 {
		placeholders := make([]string, len(f.IDs))
		for i, id := range f.IDs {
			placeholders[i] = fmt.Sprintf("$%d", idx)
			args = append(args, id)
			idx++
		}
		conditions = append(conditions, fmt.Sprintf("re.id IN (%s)", strings.Join(placeholders, ",")))
	}

	// Authors filter
	if len(f.Authors) > 0 {
		placeholders := make([]string, len(f.Authors))
		for i, author := range f.Authors {
			placeholders[i] = fmt.Sprintf("$%d", idx)
			args = append(args, author)
			idx++
		}
		conditions = append(conditions, fmt.Sprintf("re.pubkey IN (%s)", strings.Join(placeholders, ",")))
	}

	// Kinds filter
	if len(f.Kinds) > 0 {
		placeholders := make([]string, len(f.Kinds))
		for i, kind := range f.Kinds {
			placeholders[i] = fmt.Sprintf("$%d", idx)
			args = append(args, kind)
			idx++
		}
		conditions = append(conditions, fmt.Sprintf("re.kind IN (%s)", strings.Join(placeholders, ",")))
	}

	// Since filter
	if f.Since != nil {
		conditions = append(conditions, fmt.Sprintf("re.created_at >= $%d", idx))
		args = append(args, *f.Since)
		idx++
	}

	// Until filter
	if f.Until != nil {
		conditions = append(conditions, fmt.Sprintf("re.created_at <= $%d", idx))
		args = append(args, *f.Until)
		idx++
	}

	// Tag filters — each tag filter becomes an EXISTS subquery
	for tagName, tagValues := range f.Tags {
		if len(tagValues) == 0 {
			continue
		}
		tagNamePlaceholder := fmt.Sprintf("$%d", idx)
		args = append(args, tagName)
		idx++

		placeholders := make([]string, len(tagValues))
		for i, val := range tagValues {
			placeholders[i] = fmt.Sprintf("$%d", idx)
			args = append(args, val)
			idx++
		}

		subquery := fmt.Sprintf(
			"EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = re.id AND et.tag_name = %s AND et.tag_value IN (%s))",
			tagNamePlaceholder,
			strings.Join(placeholders, ","),
		)
		conditions = append(conditions, subquery)
	}

	clause := strings.Join(conditions, " AND ")
	return clause, args, idx
}
