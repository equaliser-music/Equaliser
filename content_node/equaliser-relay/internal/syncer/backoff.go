package syncer

import "time"

// backoff implements exponential backoff with a cap.
type backoff struct {
	initial time.Duration
	max     time.Duration
	current time.Duration
}

func newBackoff(initial, max time.Duration) *backoff {
	return &backoff{initial: initial, max: max, current: initial}
}

// next returns the current delay and doubles it for the next call.
func (b *backoff) next() time.Duration {
	d := b.current
	b.current *= 2
	if b.current > b.max {
		b.current = b.max
	}
	return d
}

// reset returns the backoff to its initial value.
func (b *backoff) reset() {
	b.current = b.initial
}
