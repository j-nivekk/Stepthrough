import requests

projects = requests.get('http://127.0.0.1:8000/projects').json()
recording_id = requests.get(f'http://127.0.0.1:8000/projects/{projects[0]["id"]}').json()['recordings'][0]['id']

# Create a run that will get stuck? 
# Actually, I can just write a script to start a run, and we can watch it.
