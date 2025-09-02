# 🍪 YouTube Cookies Setup Guide

## Why do we need cookies?

YouTube has implemented bot detection that blocks automated requests. To bypass this, we need to provide browser cookies that prove we're authenticated.

## How to get YouTube cookies:

### Method 1: Browser Extension (Recommended)

1. **Install a cookie export extension:**
   - Chrome: "Get cookies.txt LOCALLY" or "cookies.txt"
   - Firefox: "cookies.txt" add-on

2. **Export cookies:**
   - Go to YouTube.com in your browser
   - Make sure you're logged in to your YouTube account
   - Click the extension icon
   - Select "Export" and choose "youtube.com"
   - Save as `cookies.txt`

3. **Place the file:**
   - Copy the exported `cookies.txt` to the `/cookies/` directory
   - Replace the example file we created

### Method 2: Manual Browser Export

1. **Chrome DevTools:**
   - Open YouTube.com
   - Press F12 → Application tab → Cookies → https://youtube.com
   - Copy all cookies to Netscape format

2. **Firefox Developer Tools:**
   - Open YouTube.com  
   - Press F12 → Storage tab → Cookies → https://youtube.com
   - Export to Netscape format

## File Format

The cookies.txt file should look like:

```
# Netscape HTTP Cookie File
.youtube.com	TRUE	/	FALSE	1735689600	CONSENT	YES+cb.20210328-17-p0.en+FX+532
.youtube.com	TRUE	/	TRUE	1735689600	__Secure-YEC	CgtNY3JlOGRJPE1iYyiEuPSLBjIKCgJCUhIEGgAgOQ%3D%3D
```

## Security Notes

- Keep your cookies private - they contain authentication data
- The cookies directory is in .gitignore for security
- Cookies expire, so you may need to update them periodically

## Testing

After setting up cookies:
1. Rebuild the Docker image
2. Redeploy to VPS
3. Test with `/play shape of you` command

The bot should now be able to search YouTube without bot detection errors.
