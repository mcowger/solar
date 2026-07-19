# Frontend guidance

- For UI styling or layout changes, capture and inspect a browser screenshot before declaring the work complete. Do not rely only on DOM assertions or type checks for visual verification.
- Use DaisyUI toggles for switches. Enabled toggles must visibly use the primary color: include `toggle-primary checked:border-primary checked:bg-primary checked:text-primary-content` alongside the toggle size class.
