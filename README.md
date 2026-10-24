# Lens Protocol activity dashboard

A static, free-to-run dashboard of Lens Protocol (Lens Chain) activity:

- daily content by client (Hey, Orb, Firefly, Palus, the 3 most active other apps, and "Other apps")
- posts, comments, quotes and reposts per day
- active posters (unique accounts) per day and per period
- top 10 most active accounts, overall and per client
- client comparison table with share and change vs. the previous period
- periods: 1 day (yesterday), 7, 30 and 90 days
- filters: hide spam apps, and a minimum Lens account score (any, 1+, 5,000+, 9,000+)

## Methodology

- **Client** = the Lens app recorded on Lens Chain with each piece of content. The addresses of the four main clients are at the top of `collect.mjs`.
- **Type:** repost, comment (reply to a post), quote, otherwise post. Deleted posts are not included.
- **Active poster** = a unique account that published anything in the day or period; period figures are counted separately, not summed from days.
- Summary figures and the top 10 cover full days only ("1 day" = yesterday); today appears on the charts only.
- **Spam apps** are listed in `SPAM_APPS` in `collect.mjs` (currently Gallery Publisher, which posts mass link spam from throwaway accounts).
- **Account score** is the Lens account score (1–10,000), an ML estimate of how likely an account is genuine. Below 5,000 are mostly unscored, one-off campaign, farming and bot accounts; 9,000+ are established accounts. Scores are current values, so a new real user can start low.
- The API returns publicly visible posts only. Content that Lens hides or deletes does not appear here.
