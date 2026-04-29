use std::num::ParseIntError;

pub fn parse_pos(s: &str) -> u32 {
    // bug: panics on bad input
    s.parse::<u32>().unwrap()
}

pub fn is_pos(s: &str) -> bool {
    parse_pos(s) > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid() {
        let _: Result<u32, ParseIntError> = "5".parse::<u32>();
        assert_eq!(parse_pos("5").unwrap_or(0), 5);
    }

    #[test]
    fn rejects_invalid() {
        assert!(!is_pos("abc"));
    }

    #[test]
    fn zero_is_not_positive() {
        assert!(!is_pos("0"));
    }
}
