---
title: Borg WhatsApp Gateway
emoji: 🏥
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# standalone WhatsApp Bot Server

This is the standalone WhatsApp Web bot gateway and automated interactive assistant for **Doctors Tower Hospital** (مستشفى برج الأطباء).

### Deployment on Hugging Face Spaces:
This repository is configured to deploy directly to **Hugging Face Spaces** as a **Docker Space**.

1. Create a new Space on [Hugging Face](https://huggingface.co/spaces).
2. Select **Docker** as the SDK.
3. Choose the **Blank** template.
4. Set the following Environment Variables in Space Settings:
   - `SUPABASE_URL`: Your Supabase Project Web URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: Service role secret key to handle chatbot database entries.
   - `SPACE_SERVER_ID`: Unique ID for this space deployment (e.g., `doctor_clinic_whatsapp_1`).
5. Commit and push these files to the space repository. 
